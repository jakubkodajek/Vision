import { useVision } from "../data/context";
import type { AnnounceScope } from "../data/store";

/**
 * One persistent polite live region per view. The data layer writes finished results into
 * it ("Codex: signed in.", "Check finished: 2 of 3 signed in."); each new announcement
 * replaces the text node, so the same sentence twice in a row is still read out.
 */
export function LiveRegion({ scope }: { scope: AnnounceScope }) {
  const { state } = useVision();
  const announcement = state.announce[scope];
  return (
    <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-live={scope}>
      {announcement && <span key={announcement.n}>{announcement.text}</span>}
    </div>
  );
}
