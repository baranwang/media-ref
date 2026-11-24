import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function IndexPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <h1 className="font-heading text-xl font-semibold tracking-tight">media-ref</h1>
    </main>
  );
}
