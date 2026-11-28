import { Alert, AlertDescription, AlertTitle } from "@media-ref/ui/components/alert";
import { Badge } from "@media-ref/ui/components/badge";
import { Button } from "@media-ref/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@media-ref/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@media-ref/ui/components/tabs";
import { cn } from "@media-ref/ui/lib/utils";
import {
  RiArrowRightUpLine,
  RiCheckLine,
  RiFileCopyLine,
  RiInformationLine,
} from "@remixicon/react";
import { Link } from "@tanstack/react-router";
import type { MDXComponents } from "mdx/types";
import { Children, isValidElement, useState, type ComponentProps, type ReactNode } from "react";

/** Plain text of a node tree, e.g. the source inside a fenced code block. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** A fenced code block, already highlighted at build time; CodeBlock / CodeTabs give it the card. */
function Pre({ className, ...props }: ComponentProps<"pre">) {
  return <pre className={cn("font-mono text-xs leading-5", className)} {...props} />;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked; nothing else to do.
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      {copied ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
      {copied ? "已复制" : "复制"}
    </button>
  );
}

const CODE_CARD = "w-full overflow-hidden rounded-lg border border-border bg-card";
const CODE_HEADER = "flex h-10 items-center border-b border-border bg-muted pr-3 pl-4";

function CodeBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={CODE_CARD}>
      <div className={CODE_HEADER}>
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <CopyButton text={textOf(children).replace(/\n$/, "")} />
      </div>
      {children}
    </div>
  );
}

/** One fenced code block per entry in `items`, in the same order. */
function CodeTabs({
  items,
  defaultValue,
  children,
}: {
  items: string[];
  defaultValue?: string;
  children: ReactNode;
}) {
  const panels = Children.toArray(children).filter(isValidElement);
  const [value, setValue] = useState(defaultValue ?? items[0]!);
  const active = panels[items.indexOf(value)];
  return (
    <Tabs
      value={value}
      onValueChange={(next) => setValue(String(next))}
      className={cn(CODE_CARD, "gap-0")}
    >
      <div className={CODE_HEADER}>
        <TabsList variant="line" className="h-full gap-5 rounded-none p-0">
          {items.map((item) => (
            <TabsTrigger
              key={item}
              value={item}
              className="h-full flex-none rounded-none border-0 px-0 after:bg-primary group-data-horizontal/tabs:after:bottom-0"
            >
              {item}
            </TabsTrigger>
          ))}
        </TabsList>
        <CopyButton text={textOf(active).replace(/\n$/, "")} />
      </div>
      {items.map((item, i) => (
        <TabsContent key={item} value={item}>
          {panels[i]}
        </TabsContent>
      ))}
    </Tabs>
  );
}

function Callout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Alert>
      <RiInformationLine />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/** Numbers each H2 inside it (see `.docs-steps` in styles.css). */
function Steps({ children }: { children: ReactNode }) {
  return <div className="docs-steps flex flex-col gap-4">{children}</div>;
}

function Hint({ children }: { children: ReactNode }) {
  return <div className="text-xs leading-5">{children}</div>;
}

function Endpoint({ method, url }: { method: string; url: string }) {
  return (
    <div className="flex w-full items-center gap-3 overflow-x-auto rounded-md border border-border bg-muted px-3 py-2">
      <Badge>{method}</Badge>
      <code className="font-mono text-xs whitespace-nowrap text-foreground">{url}</code>
    </div>
  );
}

function ApproachCard({
  id,
  title,
  badge,
  badgeVariant = "secondary",
  command,
  children,
}: {
  id: string;
  title: string;
  badge: string;
  badgeVariant?: "confirmed" | "secondary" | "outline";
  command: string;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className="flex w-full scroll-mt-20 flex-col gap-2 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex items-center gap-2">
        <p className="text-sm font-bold text-foreground">{title}</p>
        <Badge variant={badgeVariant}>{badge}</Badge>
      </div>
      <div className="text-xs">{children}</div>
      <code className="block rounded-md bg-muted px-3 py-2 font-mono text-xs wrap-break-word text-foreground">
        {command}
      </code>
    </div>
  );
}

function ButtonLink({ to, children }: { to: "/api-keys"; children: ReactNode }) {
  return (
    <Button variant="outline" size="sm" nativeButton={false} render={<Link to={to} />}>
      <RiArrowRightUpLine />
      {children}
    </Button>
  );
}

export const docsMdxComponents = {
  h2: ({ className, ...props }: ComponentProps<"h2">) => (
    <h2
      className={cn(
        "mt-8 flex scroll-mt-20 items-center gap-3 text-lg font-bold tracking-tight text-foreground",
        className,
      )}
      {...props}
    />
  ),
  code: (props: ComponentProps<"code">) => (
    <code className="font-mono text-foreground" {...props} />
  ),
  pre: Pre,
  a: (props: ComponentProps<"a">) => (
    <a
      className="text-foreground underline underline-offset-4 transition-colors hover:text-primary"
      {...props}
    />
  ),
  table: (props: ComponentProps<"table">) => (
    <div className="w-full rounded-lg border border-border bg-card px-4 py-1">
      <Table {...props} />
    </div>
  ),
  thead: TableHeader,
  tbody: TableBody,
  tr: (props: ComponentProps<"tr">) => <TableRow className="hover:bg-transparent" {...props} />,
  th: TableHead,
  td: (props: ComponentProps<"td">) => (
    <TableCell
      className="text-muted-foreground first:text-foreground last:whitespace-normal"
      {...props}
    />
  ),
  CodeBlock,
  CodeTabs,
  Callout,
  Steps,
  Hint,
  Endpoint,
  ApproachCard,
  ButtonLink,
} satisfies MDXComponents;
