import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

interface Props {
	label: string;
	openByDefault?: boolean;
	children: ComponentChildren;
}

export function Section({ label, openByDefault = true, children }: Props) {
	const [open, setOpen] = useState(openByDefault);
	return (
		<div class={`editor-section ${open ? 'open' : 'closed'}`}>
			<button
				type="button"
				class="editor-section-header"
				onClick={() => setOpen(o => !o)}
				aria-expanded={open}
			>
				<span class="editor-section-chev">{open ? '▾' : '▸'}</span>
				<span class="editor-section-label">{label}</span>
			</button>
			{open && <div class="editor-section-body">{children}</div>}
		</div>
	);
}
