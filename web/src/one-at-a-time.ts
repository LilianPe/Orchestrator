/**
 * Runs one send at a time (ORC-494): a call while one is in flight does nothing, so a double click on a slow connection sends
 * once. The flag is set before React renders the button disabled, which a second click can come before. A send that fails
 * frees the button too, what was typed kept to send again.
 */
export function oneAtATime(busy: (on: boolean) => void): (send: () => Promise<unknown>) => void {
  let inFlight = false;
  const done = () => {
    inFlight = false;
    busy(false);
  };
  return (send) => {
    if (inFlight) return;
    inFlight = true;
    busy(true);
    try {
      send().then(done, done);
    } catch {
      done();
    }
  };
}
