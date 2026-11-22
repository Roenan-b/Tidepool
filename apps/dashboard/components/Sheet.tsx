'use client';
/**
 * Modal sheet that drops from the window title bar. Built on <dialog>.showModal(), which provides
 * focus containment, Escape to cancel and an inert background.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';

export function Sheet(props: { open: boolean; onClose: () => void; title: string; children: ReactNode; describedBy?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { open, onClose } = props;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby={titleId}
      aria-describedby={props.describedBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
    >
      {open ? (
        <div className="sheet-inner">
          <h2 id={titleId}>{props.title}</h2>
          {props.children}
        </div>
      ) : null}
    </dialog>
  );
}
