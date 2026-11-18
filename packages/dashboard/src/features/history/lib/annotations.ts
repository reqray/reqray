/**
 * A moment in the window that explains part of its shape.
 *
 * Only things the panel actually witnessed: a detector pattern seen here for
 * the first time, and the process starting. No inferred deploys, no guessed
 * incidents — an annotation is a claim that something happened, and a wrong
 * one sends somebody looking for a change nobody made.
 */
export interface Annotation {
  readonly at: number;
  readonly kind: 'finding' | 'restart';
  readonly label: string;
  readonly detail: string;
}
