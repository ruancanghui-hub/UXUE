import type { CSSProperties, ReactNode } from 'react';

type IconProps = { className?: string; style?: CSSProperties; title?: string };

function Svg({ className, style, title, children }: IconProps & { children: ReactNode }) {
  return (
    <svg className={className} style={style} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

const stroke = { strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

/** SF 风线框图标：图层类型识别用 */
export const LayerIcons = {
  page: (props: IconProps) => (
    <Svg {...props}>
      <rect x="3.5" y="1.5" width="9" height="13" rx="1.5" stroke="currentColor" {...stroke} />
      <path d="M5.5 4.5h5M5.5 7h5M5.5 9.5h3" stroke="currentColor" {...stroke} />
    </Svg>
  ),
  group: (props: IconProps) => (
    <Svg {...props}>
      <rect x="2.5" y="2.5" width="7" height="7" rx="1" stroke="currentColor" {...stroke} />
      <rect x="6.5" y="6.5" width="7" height="7" rx="1" stroke="currentColor" {...stroke} />
    </Svg>
  ),
  image: (props: IconProps) => (
    <Svg {...props}>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" stroke="currentColor" {...stroke} />
      <circle cx="5.75" cy="6.5" r="1" fill="currentColor" />
      <path d="M2.5 10.5l3-2.5 2.5 2 2.5-3 3 3.5" stroke="currentColor" {...stroke} />
    </Svg>
  ),
  ref: (props: IconProps) => (
    <Svg {...props}>
      <path d="M6.5 9.5a2.5 2.5 0 0 1 0-3.5l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5L10.5 9" stroke="currentColor" {...stroke} />
      <path d="M9.5 6.5a2.5 2.5 0 0 1 0 3.5L8 11.5a2.5 2.5 0 1 1-3.5-3.5L5.5 7" stroke="currentColor" {...stroke} />
    </Svg>
  ),
  decor: (props: IconProps) => (
    <Svg {...props}>
      <rect x="2.5" y="3.5" width="11" height="9" rx="2.5" stroke="currentColor" {...stroke} />
    </Svg>
  ),
  block: (props: IconProps) => (
    <Svg {...props}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" stroke="currentColor" strokeDasharray="2.5 2" {...stroke} />
    </Svg>
  ),
  stroke: (props: IconProps) => (
    <Svg {...props}>
      <path d="M3 12.5c2-4 3.5-7 5-8.5 1.2-1.2 2.8-1.2 3.5 0 .6 1-.2 2.4-1.5 3.5L6 11.5" stroke="currentColor" {...stroke} />
      <path d="M3 12.5h2.5" stroke="currentColor" {...stroke} />
    </Svg>
  ),
  sketchText: (props: IconProps) => (
    <Svg {...props}>
      <path d="M4 3.5h8M8 3.5v9M5.5 12.5h5" stroke="currentColor" {...stroke} />
    </Svg>
  ),
  prompt: (props: IconProps) => (
    <Svg {...props}>
      <path d="M3.5 11.5l1.2-4.2L11.8 2.8a1.4 1.4 0 0 1 2 2L8.2 10.8 4 12z" stroke="currentColor" {...stroke} />
      <path d="M10.2 4.2l2 2" stroke="currentColor" {...stroke} />
    </Svg>
  ),
  theme: (props: IconProps) => (
    <Svg {...props}>
      <path d="M8 2.5l1.6 3.3 3.6.5-2.6 2.6.6 3.6L8 10.8 4.8 12.5l.6-3.6-2.6-2.6 3.6-.5z" stroke="currentColor" {...stroke} />
    </Svg>
  ),
  missing: (props: IconProps) => (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" {...stroke} />
      <path d="M8 5v3.5M8 11h.01" stroke="currentColor" {...stroke} />
    </Svg>
  ),
  chevron: (props: IconProps & { expanded?: boolean }) => (
    <Svg {...props} className={`${props.className ?? ''} ${props.expanded ? 'expanded' : ''}`.trim()}>
      <path d="M6 4l4 4-4 4" stroke="currentColor" {...stroke} />
    </Svg>
  ),
};
