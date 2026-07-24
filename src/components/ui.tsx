import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

export function cn(...classes: Array<string | false | null | undefined>) { return classes.filter(Boolean).join(' ') }

export function Button({ children, variant='primary', className='', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary'|'secondary'|'ghost'|'danger'; children: ReactNode }) {
  return <button data-slot="button" className={cn('btn', `btn-${variant}`, className)} {...props}>{children}</button>
}

export function Badge({ children, variant='default' }: { children: ReactNode; variant?: 'default'|'secondary'|'outline'|'success' }) {
  return <span data-slot="badge" className={cn('badge', `badge-${variant}`)}>{children}</span>
}

export function Toggle({ checked, onChange, label }: { checked:boolean; onChange:(value:boolean)=>void; label:string }) {
  return <button type="button" role="switch" aria-checked={checked} data-slot="switch" className={cn('toggle', checked && 'is-on')} onClick={() => onChange(!checked)}><span />{label}</button>
}

export function Card({ children, className='' }: { children: ReactNode; className?: string }) { return <section data-slot="card" className={cn('panel', className)}>{children}</section> }
export function CardHeader({ children }: { children: ReactNode }) { return <div data-slot="card-header" className="panel-head">{children}</div> }
export function CardContent({ children, className='' }: { children: ReactNode; className?: string }) { return <div data-slot="card-content" className={className}>{children}</div> }

export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input data-slot="input" {...props} /> }
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) { return <select data-slot="select" {...props} /> }
export function Slider(props: InputHTMLAttributes<HTMLInputElement>) { return <input data-slot="slider" type="range" {...props} /> }
