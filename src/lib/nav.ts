// Tiny cross-view navigation so a section can hand the user to the next step.
export type View = "setup" | "connect" | "pipeline" | "calls" | "improve" | "ask" | "brain";
export const go = (view: View) => window.dispatchEvent(new CustomEvent<View>("harry-nav", { detail: view }));

/** Open Ask Harry with a question already submitted. */
export function askHarry(q: string) {
  (window as unknown as { __harryAsk?: string }).__harryAsk = q;
  go("ask");
  window.dispatchEvent(new CustomEvent("harry-ask"));
}
