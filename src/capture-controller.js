// Serialize native start/stop calls and coalesce requests that have not started.
// The desired state changes immediately, so rapid toggles don't read stale UI flags.
export function captureController(transition, isActive, onError) {
  let desired = false;
  let version = 0;
  let pending = Promise.resolve();
  return {
    get desired() { return desired; },
    set(on) {
      desired = on;
      const request = ++version;
      pending = pending.then(async () => {
        if (request !== version) return;
        try {
          await transition(on);
        } catch (error) {
          onError(error);
        } finally {
          if (request === version) desired = isActive();
        }
      });
      return pending;
    },
  };
}
