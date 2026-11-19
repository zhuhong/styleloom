import { renderMarkdown } from "../lib/markdown";

type MarkdownProps = {
  content: string;
  projectId?: string;
};

export function Markdown({ content, projectId }: MarkdownProps) {
  // 外层 bubble 已带 .markdown；这里只注入安全 HTML。
  return <span dangerouslySetInnerHTML={{ __html: renderMarkdown(content, projectId) }} />;
}