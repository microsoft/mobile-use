package dev.mobileuse.text;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;

public final class TextMain {
    private static final String PREFIX = "MOBILE_USE_TEXT_V1_";
    private static final long ROOT_TIMEOUT_MS = 2000;
    private static String phase = "REQUEST";

    private static final class Request {
        final int user;
        final Rect bounds;
        final String packageName, className, resourceId, textHash, text;

        Request(String encoded) throws IOException {
            if (encoded.length() > 32768) throw new IllegalArgumentException("Payload too large");
            DataInputStream input = new DataInputStream(
                new ByteArrayInputStream(Base64.decode(encoded, Base64.NO_WRAP)));
            if (input.readInt() != 2) throw new IllegalArgumentException("Unknown protocol");
            user = input.readInt();
            int x = input.readInt(), y = input.readInt();
            int width = input.readInt(), height = input.readInt();
            if (user < 0 || x < 0 || y < 0 || width <= 0 || height <= 0 ||
                    (long) x + width > Integer.MAX_VALUE || (long) y + height > Integer.MAX_VALUE) {
                throw new IllegalArgumentException("Invalid target");
            }
            bounds = new Rect(x, y, x + width, y + height);
            packageName = readString(input);
            className = readString(input);
            resourceId = readString(input);
            textHash = readString(input);
            text = readString(input);
            if (input.read() != -1 || !textHash.matches("[0-9a-f]{64}") || text.isEmpty() || text.length() > 256) {
                throw new IllegalArgumentException("Invalid text bounds");
            }
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                if ((c < 32 && c != '\t' && c != '\n' && c != '\r') ||
                        (c >= 127 && c <= 159) || c == '\ufffe' || c == '\uffff') {
                    throw new IllegalArgumentException("Unsupported control character");
                }
            }
        }

        private static String readString(DataInputStream input) throws IOException {
            int length = input.readInt();
            if (length < 0 || length > 16384) throw new IllegalArgumentException("Invalid string");
            byte[] bytes = new byte[length];
            input.readFully(bytes);
            return StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
        }
    }

    private static String string(CharSequence value) {
        return value == null ? "" : value.toString();
    }

    private static int currentUser() throws ReflectiveOperationException {
        return (Integer) Class.forName("android.app.ActivityManager").getMethod("getCurrentUser").invoke(null);
    }

    private static String mismatch(AccessibilityNodeInfo node, Request request, boolean checkBounds) {
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        if (!node.isVisibleToUser()) return "FIELD_VISIBLE";
        if (!node.isEditable()) return "FIELD_EDITABLE";
        if (!node.isFocused()) return "FIELD_FOCUS";
        if (!node.isEnabled()) return "FIELD_ENABLED";
        if (node.isPassword()) return "FIELD_PASSWORD";
        if (!request.packageName.equals(string(node.getPackageName()))) return "FIELD_PACKAGE";
        if (!request.className.equals(string(node.getClassName())) || !request.className.endsWith("EditText")) return "FIELD_CLASS";
        if (!request.resourceId.equals(string(node.getViewIdResourceName()))) return "FIELD_ID";
        return !checkBounds || request.bounds.equals(bounds) ? null : "FIELD_BOUNDS";
    }

    private static boolean activeWindow(AccessibilityNodeInfo node) {
        AccessibilityWindowInfo window = node.getWindow();
        if (window == null) return false;
        try {
            return window.getDisplayId() == 0 &&
                window.getType() == AccessibilityWindowInfo.TYPE_APPLICATION && window.isActive();
        } finally {
            window.recycle();
        }
    }

    private static void collect(AccessibilityNodeInfo node, int depth, List<AccessibilityNodeInfo> nodes) {
        nodes.add(node);
        if (depth > 64 || nodes.size() > 2000) throw new IllegalStateException("Hierarchy too large");
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) collect(child, depth + 1, nodes);
        }
    }

    private static void attribute(StringBuilder xml, String name, String value) {
        xml.append(' ').append(name).append("=\"");
        for (int i = 0; i < value.length();) {
            int code = value.codePointAt(i);
            i += Character.charCount(code);
            switch (code) {
                case '&': xml.append("&amp;"); break;
                case '"': xml.append("&quot;"); break;
                case '<': xml.append("&lt;"); break;
                case '\t': xml.append("&#9;"); break;
                case '\n': xml.append("&#10;"); break;
                case '\r': xml.append("&#13;"); break;
                default:
                    if (code < 32 || (code >= 0xd800 && code <= 0xdfff) ||
                            code == 0xfffe || code == 0xffff) xml.append('\ufffd');
                    else xml.appendCodePoint(code);
            }
        }
        xml.append('"');
    }

    private static String textHash(AccessibilityNodeInfo node) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update((byte) (node.isShowingHintText() ? 1 : 0));
            String text = string(node.getText());
            for (int i = 0; i < text.length(); i++) {
                char code = text.charAt(i);
                digest.update((byte) (code >> 8));
                digest.update((byte) code);
            }
            StringBuilder hex = new StringBuilder(64);
            for (byte value : digest.digest()) {
                hex.append(Character.forDigit((value & 255) >> 4, 16));
                hex.append(Character.forDigit(value & 15, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException failure) {
            throw new IllegalStateException("SHA-256 unavailable");
        }
    }

    private static AccessibilityNodeInfo awaitRoot(UiAutomation automation) {
        phase = "ROOT";
        long start = SystemClock.uptimeMillis();
        for (int attempt = 0; attempt <= ROOT_TIMEOUT_MS / 100; attempt++) {
            AccessibilityNodeInfo root = automation.getRootInActiveWindow();
            if (root != null) return root;
            long remaining = ROOT_TIMEOUT_MS - (SystemClock.uptimeMillis() - start);
            if (remaining <= 0) break;
            // A new accessibility connection can precede publication of its active window.
            SystemClock.sleep(Math.min(100, remaining));
        }
        throw new IllegalStateException("Active root unavailable");
    }

    private static String dump(UiAutomation automation, int rotation) {
        AccessibilityNodeInfo root = awaitRoot(automation);
        List<AccessibilityNodeInfo> nodes = new ArrayList<>();
        AccessibilityWindowInfo window = null;
        try {
            nodes.add(root);
            phase = "WINDOW";
            window = root.getWindow();
            if (window == null || window.getDisplayId() != 0) throw new IllegalStateException("No primary window");
            nodes.clear();
            phase = "HIERARCHY";
            collect(root, 1, nodes);
            StringBuilder xml = new StringBuilder("<hierarchy rotation=\"" + rotation + "\">");
            for (AccessibilityNodeInfo node : nodes) {
                if (!node.isVisibleToUser()) continue;
                if (node.isEditable() && node.isFocused() && !node.refresh()) {
                    throw new IllegalStateException("Focused field unavailable");
                }
                String text = node.isPassword() ? "[redacted]" : string(node.getText());
                String label = string(node.getContentDescription());
                String hint = string(node.getHintText());
                if (text.length() + (label.isEmpty() ? hint.length() : label.length()) > 4096) {
                    throw new IllegalStateException("Field too large");
                }
                Rect bounds = new Rect();
                node.getBoundsInScreen(bounds);
                xml.append("<node");
                attribute(xml, "class", string(node.getClassName()));
                attribute(xml, "resource-id", string(node.getViewIdResourceName()));
                attribute(xml, "text", text);
                if (node.isEditable() && !node.isPassword()) attribute(xml, "text-sha256", textHash(node));
                attribute(xml, "content-desc", label);
                attribute(xml, "hint", hint);
                attribute(xml, "bounds", "[" + bounds.left + "," + bounds.top + "][" + bounds.right + "," + bounds.bottom + "]");
                attribute(xml, "enabled", Boolean.toString(node.isEnabled()));
                attribute(xml, "clickable", Boolean.toString(node.isClickable()));
                attribute(xml, "focused", Boolean.toString(node.isFocused()));
                attribute(xml, "password", Boolean.toString(node.isPassword()));
                xml.append("/>");
                if (xml.length() > 2 * 1024 * 1024) throw new IllegalStateException("Hierarchy too large");
            }
            xml.append("</hierarchy>");
            if (xml.toString().getBytes(StandardCharsets.UTF_8).length > 2 * 1024 * 1024) {
                throw new IllegalStateException("Hierarchy too large");
            }
            return xml.toString();
        } finally {
            if (window != null) window.recycle();
            for (AccessibilityNodeInfo node : nodes) node.recycle();
        }
    }

    private static String append(UiAutomation automation, Request request) throws ReflectiveOperationException {
        phase = "TARGET";
        if (currentUser() != request.user) return "ELEMENT_CHANGED_USER";
        AccessibilityNodeInfo root = awaitRoot(automation);
        phase = "TARGET";
        List<AccessibilityNodeInfo> nodes = new ArrayList<>();
        AccessibilityWindowInfo window = null;
        try {
            nodes.add(root);
            window = root.getWindow();
            if (window == null) return "ELEMENT_CHANGED_WINDOW_MISSING";
            if (window.getDisplayId() != 0) return "ELEMENT_CHANGED_WINDOW_DISPLAY";
            if (window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) return "ELEMENT_CHANGED_WINDOW_TYPE";
            if (!window.isActive()) return "ELEMENT_CHANGED_WINDOW_ACTIVE";
            if (!request.packageName.equals(string(root.getPackageName()))) return "ELEMENT_CHANGED_ROOT_PACKAGE";
            nodes.clear();
            collect(root, 1, nodes);
            AccessibilityNodeInfo field = null;
            for (AccessibilityNodeInfo node : nodes) {
                if (node.isEditable() && node.isFocused()) {
                    if (field != null) return "ELEMENT_CHANGED_FIELD_AMBIGUOUS";
                    String mismatch = mismatch(node, request, true);
                    if (mismatch != null) return "ELEMENT_CHANGED_" + mismatch;
                    field = node;
                }
            }
            if (field == null) return "ELEMENT_CHANGED_FIELD_MISSING";
            if (!field.refresh()) return "ELEMENT_CHANGED_FIELD_REFRESH";
            String mismatch = mismatch(field, request, true);
            if (mismatch != null) return "ELEMENT_CHANGED_" + mismatch;
            String previous = string(field.getText());
            boolean hint = field.isShowingHintText();
            if (!request.textHash.equals(textHash(field))) {
                return "ELEMENT_CHANGED_FIELD_TEXT";
            }
            if (hint) previous = "";
            String desired = previous + request.text;
            String label = string(field.getContentDescription());
            if (label.isEmpty()) label = string(field.getHintText());
            if (desired.length() + label.length() > 4096 ||
                    !field.getActionList().contains(AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_TEXT)) {
                return "UNSUPPORTED";
            }
            if (currentUser() != request.user) return "ELEMENT_CHANGED_USER";
            if (!activeWindow(field)) return "ELEMENT_CHANGED_FIELD_WINDOW";
            int windowId = field.getWindowId();
            Bundle arguments = new Bundle();
            arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, desired);
            // ACTION_SET_TEXT writes text, including line breaks, without sending Enter or submitting.
            phase = "WRITE";
            if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) return "FAILED";
            phase = "VERIFY";
            // Text can resize or scroll its original node; pre-write geometry remains strict.
            if (!field.refresh() || mismatch(field, request, false) != null ||
                    field.getWindowId() != windowId || !activeWindow(field) || currentUser() != request.user ||
                    !desired.equals(string(field.getText()))) return "FAILED";
            return "OK";
        } finally {
            if (window != null) window.recycle();
            for (AccessibilityNodeInfo node : nodes) node.recycle();
        }
    }

    public static void main(String[] args) {
        HandlerThread thread = new HandlerThread("mobile-use-text");
        UiAutomation automation = null;
        boolean connected = false;
        String result = null;
        boolean hierarchy = false;
        phase = "REQUEST";
        try {
            boolean check = args.length == 1 && "--check".equals(args[0]);
            hierarchy = args.length == 2 && "--dump".equals(args[0]) && args[1].matches("[0-3]");
            if (!hierarchy && args.length != 1) throw new IllegalArgumentException("Expected one request");
            Request request = check || hierarchy ? null : new Request(args[0]);
            thread.start();
            phase = "CONNECT";
            Class<?> connectionType = Class.forName("android.app.IUiAutomationConnection");
            Object connection = Class.forName("android.app.UiAutomationConnection").getConstructor().newInstance();
            automation = UiAutomation.class.getConstructor(Looper.class, connectionType)
                .newInstance(thread.getLooper(), connection);
            // Do not suppress the user's enabled accessibility services.
            UiAutomation.class.getMethod("connect", int.class).invoke(
                automation, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
            connected = true;
            phase = "CONFIGURE";
            AccessibilityServiceInfo info = automation.getServiceInfo();
            if (info == null) throw new IllegalStateException("No automation service");
            info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS |
                AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            automation.setServiceInfo(info);
            result = check ? "READY" : hierarchy ? dump(automation, Integer.parseInt(args[1])) : append(automation, request);
        } catch (ReflectiveOperationException | IOException | RuntimeException failure) {
            result = "ERROR_" + phase;
            System.err.println("mobile-use: text helper failed; text may have changed; do not replay");
            hierarchy = false;
        } finally {
            if (connected) {
                try {
                    UiAutomation.class.getMethod("disconnect").invoke(automation);
                } catch (ReflectiveOperationException failure) {
                    System.err.println("mobile-use: text helper disconnect failed");
                    result = "ERROR_DISCONNECT";
                    hierarchy = false;
                }
            }
            thread.quitSafely();
        }
        byte[] output = ((hierarchy ? result : PREFIX + result) + "\n").getBytes(StandardCharsets.UTF_8);
        System.out.write(output, 0, output.length);
        System.out.flush();
    }
}
