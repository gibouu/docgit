import type { ReactNode } from 'react';

export function Modal(props: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}
