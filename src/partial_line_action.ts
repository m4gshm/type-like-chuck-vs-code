/** A suppressed completion that mostly extends the line right below the cursor,
 * offered instead as a code action inserting the difference into that line. */
export interface PartialLineCandidate {
  fileName: string;
  /** The document version the positions were computed against; any edit invalidates. */
  documentVersion: number;
  /** 0-based line to insert into. */
  line: number;
  character: number;
  insert: string;
  completion: string;
}

export class PartialLineActionStore {
  private candidate: PartialLineCandidate | undefined;

  constructor(private readonly onChanged?: (candidate: PartialLineCandidate | undefined) => void) {}

  set(candidate: PartialLineCandidate): void {
    this.candidate = candidate;
    this.onChanged?.(candidate);
  }

  /** The candidate for this document, unless the document changed since it was computed. */
  get(fileName: string, documentVersion: number): PartialLineCandidate | undefined {
    const candidate = this.candidate;
    if (candidate === undefined || candidate.fileName !== fileName || candidate.documentVersion !== documentVersion) {
      return undefined;
    }
    return candidate;
  }
}
