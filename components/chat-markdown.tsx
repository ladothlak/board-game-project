"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown renderer for chat messages. Lives in its own module so the
 * react-markdown/remark stack (~330 KB) is lazy-loaded only when an
 * assistant message actually appears — not on every game page load.
 */
export default function ChatMarkdown({
  content,
  renderLink,
}: {
  content: string;
  renderLink: (props: { node?: unknown; href?: string; children?: React.ReactNode }) => React.ReactNode;
}) {
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: renderLink }}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
