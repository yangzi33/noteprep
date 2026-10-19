import { DOCUMENT_SECTION_KINDS, type DocumentKind, type LessonPackage, type Section } from "./schema";

type KindsOf<D extends DocumentKind> = (typeof DOCUMENT_SECTION_KINDS)[D][number];
type SectionsFor<D extends DocumentKind> = Extract<Section, { kind: KindsOf<D> }>[];

/**
 * What each document may contain, as types. `WorksheetView` is built from the sections `exercises` and
 * `alignment` only: there is no `solutions` section in it, and no block type that carries an answer in the
 * exercises section, so a worksheet containing an answer does not type-check.
 */
export type NotesView = { document: "notes"; sections: SectionsFor<"notes"> };
export type WorksheetView = { document: "worksheet"; sections: SectionsFor<"worksheet"> };
export type SolutionsView = { document: "solutions"; sections: SectionsFor<"solutions"> };
export type DocumentView = NotesView | WorksheetView | SolutionsView;

/** The sections of one requested document, in document order. Throws if the package does not contain it. */
export function documentView(pkg: LessonPackage, id: "notes"): NotesView;
export function documentView(pkg: LessonPackage, id: "worksheet"): WorksheetView;
export function documentView(pkg: LessonPackage, id: "solutions"): SolutionsView;
export function documentView(pkg: LessonPackage, id: DocumentKind): DocumentView;
export function documentView(pkg: LessonPackage, id: DocumentKind): DocumentView {
  const doc = pkg.documents.find((d) => d.id === id);
  if (!doc) throw new RangeError(`the package has no ${id} document`);
  const allowed: readonly string[] = DOCUMENT_SECTION_KINDS[id];
  const sections = doc.sectionIds.map((sectionId) => {
    const found = pkg.sections.find((s) => s.id === sectionId);
    if (!found) throw new RangeError(`section ${sectionId} is missing`);
    if (!allowed.includes(found.kind)) throw new RangeError(`a ${found.kind} section does not belong in the ${id} document`);
    return found;
  });
  return { document: id, sections } as DocumentView;
}
