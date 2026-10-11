// Harry's app-level primitives, built on shadcn/ui so every view shares one look.

import { ReactNode } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button as UIButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card as UICard } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export const cx = cn;

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  className,
  title,
  size = "default",
  type,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "outline" | "danger" | "secondary";
  disabled?: boolean;
  className?: string;
  title?: string;
  size?: "default" | "sm" | "lg";
  type?: "button" | "submit";
}) {
  const v = variant === "primary" ? "default" : variant === "danger" ? "destructive" : variant;
  return (
    <UIButton title={title} type={type} disabled={disabled} onClick={onClick} variant={v} size={size} className={className}>
      {children}
    </UIButton>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <UICard className={cn("gap-0 py-0 shadow-none", className)}>{children}</UICard>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin", className)} />;
}

export function Dot({ ok, warn }: { ok?: boolean; warn?: boolean }) {
  return (
    <span className="relative flex size-2">
      {ok && <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-40" />}
      <span className={cn("relative inline-flex size-2 rounded-full", ok ? "bg-primary" : warn ? "bg-amber-400" : "bg-destructive")} />
    </span>
  );
}

export function Pill({ children, tone = "mute" }: { children: ReactNode; tone?: "mute" | "brand" | "warn" | "bad" }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full border-transparent px-2 font-medium",
        tone === "mute" && "bg-muted text-muted-foreground",
        tone === "brand" && "bg-primary/15 text-brand-2",
        tone === "warn" && "bg-amber-400/15 text-amber-300",
        tone === "bad" && "bg-destructive/15 text-destructive",
      )}
    >
      {children}
    </Badge>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <Alert variant="destructive" className="border-destructive/30 bg-destructive/10">
      <AlertCircle />
      <AlertDescription className="selectable whitespace-pre-wrap">{children}</AlertDescription>
    </Alert>
  );
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{eyebrow}</div>}
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("text-xs font-medium tracking-wider text-muted-foreground uppercase", className)}>{children}</div>;
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl border bg-card text-muted-foreground [&_svg]:size-5">{icon}</div>
      <div className="mt-4 font-medium">{title}</div>
      {children && <div className="mt-1 max-w-sm text-sm text-muted-foreground">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
