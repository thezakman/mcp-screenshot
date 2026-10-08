import type { CaptureMetadata, Evidence } from "./evidence.js";
import type { ReviewState } from "./reviews.js";
export function presentReview(review: ReviewState) {
  return {
    revision: review.revision,
    status: review.status,
    ...(review.latest
      ? {
          reviewed_at: review.latest.reviewed_at,
          reviewer: review.latest.reviewer,
          attribution: review.latest.attribution,
          event_sha256: review.latest.event_sha256,
        }
      : {}),
  };
}
type EvidenceView = CaptureMetadata &
  Partial<Pick<Evidence, "id" | "context" | "association">> & {
    path?: string;
    exported_path?: string;
    integrity?: string;
    persisted?: boolean;
    image_included?: boolean;
    review?: ReviewState;
  };
export type Detail = "summary" | "full";
/** Presentation only: original manifests and images are never truncated or rewritten. */
export function presentEvidence(
  item: EvidenceView,
  detail: Detail = "summary",
) {
  if (detail === "full") return item;
  return Object.fromEntries(
    Object.entries({
      id: item.id,
      captured_at: item.captured_at,
      path: item.path,
      exported_path: item.exported_path,
      width: item.width,
      height: item.height,
      bytes: item.bytes,
      sha256: item.sha256,
      case_id: item.context?.case_id,
      label: item.context?.label,
      exchange_id: item.context?.exchange_id,
      association: item.association,
      verification: item.verification,
      window: item.window
        ? { id: item.window.id, app: item.window.app, title: item.window.title }
        : undefined,
      display: item.display,
      integrity: item.integrity,
      persisted: item.persisted,
      image_included: item.image_included,
      warnings: item.warnings,
      review: item.review ? presentReview(item.review) : undefined,
    }).filter(([, value]) => value !== undefined),
  );
}
