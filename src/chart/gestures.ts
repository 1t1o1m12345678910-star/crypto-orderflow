export interface GestureHandlers {
  onPan: (dx: number, dy: number) => void;
  onPinch: (scale: number) => void;
  onWheel: (deltaY: number, shift: boolean) => void;
  onReset: () => void;
  onHover: (x: number, y: number) => void;
  onLeave: () => void;
}

export function bindChartGestures(target: HTMLElement, handlers: GestureHandlers): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  let moved = false;
  let lastTap = 0;

  const local = (event: PointerEvent): { x: number; y: number } => {
    const rect = target.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const distance = (): number => {
    const points = [...pointers.values()];
    if (points.length < 2) return 0;
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  };

  const down = (event: PointerEvent) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    target.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    moved = false;
    if (pointers.size === 2) pinchDistance = distance();
  };

  const move = (event: PointerEvent) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const next = { x: event.clientX, y: event.clientY };
    if (pointers.size === 1) {
      const dx = next.x - previous.x;
      const dy = next.y - previous.y;
      if (Math.hypot(dx, dy) > 3) moved = true;
      if (moved) handlers.onPan(dx, dy);
      else handlers.onHover(local(event).x, local(event).y);
    } else if (pointers.size >= 2) {
      pointers.set(event.pointerId, next);
      const nextDistance = distance();
      if (pinchDistance > 0 && nextDistance > 0) {
        const scale = nextDistance / pinchDistance;
        if (Number.isFinite(scale) && scale > 0 && Math.abs(scale - 1) > 0.01) handlers.onPinch(scale);
      }
      pinchDistance = nextDistance;
      moved = true;
      return;
    }
    pointers.set(event.pointerId, next);
  };

  const up = (event: PointerEvent) => {
    const point = local(event);
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
    if (pointers.size > 0) return;
    if (!moved) {
      const now = Date.now();
      if (now - lastTap < 320) {
        handlers.onReset();
        lastTap = 0;
      } else {
        lastTap = now;
        handlers.onHover(point.x, point.y);
      }
    }
  };

  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    handlers.onWheel(event.deltaY, event.shiftKey);
  };

  target.addEventListener("pointerdown", down);
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
  target.addEventListener("pointerleave", () => {
    if (pointers.size === 0) handlers.onLeave();
  });
  target.addEventListener("wheel", wheel, { passive: false });

  return () => {
    target.removeEventListener("pointerdown", down);
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
    target.removeEventListener("wheel", wheel);
  };
}
