package dev.mobileuse.gestures;

import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.MotionEvent;
import android.view.ViewConfiguration;
import java.lang.reflect.Method;

public final class GestureMain {
    private final Object manager;
    private final Method inject;
    private final Method setDisplay;

    private GestureMain() throws ReflectiveOperationException {
        Class<?> managerClass;
        try {
            managerClass = Class.forName("android.hardware.input.InputManagerGlobal");
        } catch (ClassNotFoundException olderAndroid) {
            managerClass = Class.forName("android.hardware.input.InputManager");
        }
        manager = managerClass.getMethod("getInstance").invoke(null);
        inject = managerClass.getMethod("injectInputEvent", InputEvent.class, int.class);
        setDisplay = MotionEvent.class.getMethod("setDisplayId", int.class);
    }

    private void send(int action, long downTime, long eventTime, int x, int y)
            throws ReflectiveOperationException {
        MotionEvent event = MotionEvent.obtain(
            downTime, eventTime, action, x, y, action == MotionEvent.ACTION_UP ? 0f : 1f,
            1f, 0, 1f, 1f, -1, 0);
        try {
            event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            setDisplay.invoke(event, 0);
            // WAIT_FOR_FINISH: do not report success when Android rejects or times out injection.
            if (!Boolean.TRUE.equals(inject.invoke(manager, event, 2))) {
                throw new IllegalStateException("Input injection was not acknowledged");
            }
        } finally {
            event.recycle();
        }
    }

    private long doubleTap(int x, int y, int delayMs) throws ReflectiveOperationException {
        long firstDown = SystemClock.uptimeMillis();
        send(MotionEvent.ACTION_DOWN, firstDown, firstDown, x, y);
        SystemClock.sleep(10);
        long firstUp = SystemClock.uptimeMillis();
        send(MotionEvent.ACTION_UP, firstDown, firstUp, x, y);
        long remaining = firstUp + delayMs - SystemClock.uptimeMillis();
        if (remaining > 0) SystemClock.sleep(remaining);
        long secondDown = SystemClock.uptimeMillis();
        if (secondDown - firstUp > ViewConfiguration.getDoubleTapTimeout()) {
            throw new IllegalStateException("The double-tap timing window was missed");
        }
        send(MotionEvent.ACTION_DOWN, secondDown, secondDown, x, y);
        SystemClock.sleep(10);
        send(MotionEvent.ACTION_UP, secondDown, SystemClock.uptimeMillis(), x, y);
        return secondDown - firstUp;
    }

    public static void main(String[] args) {
        try {
            if (args.length == 1 && "--check".equals(args[0])) {
                new GestureMain();
                System.out.println("MOBILE_USE_GESTURES_V1_READY");
                return;
            }
            if (args.length != 3) throw new IllegalArgumentException("Expected x, y, delayMs");
            int x = Integer.parseInt(args[0]);
            int y = Integer.parseInt(args[1]);
            int delayMs = Integer.parseInt(args[2]);
            if (x < 0 || y < 0 || delayMs < 0 || delayMs > 250) {
                throw new IllegalArgumentException("Gesture parameters out of range");
            }
            long gap = new GestureMain().doubleTap(x, y, delayMs);
            System.out.println("MOBILE_USE_DOUBLE_TAP_V1 " + gap);
        } catch (ReflectiveOperationException | RuntimeException failure) {
            System.err.println("mobile-use: gesture helper failed; input may be partial; do not replay");
            System.exit(1);
        }
    }
}
