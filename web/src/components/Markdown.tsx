// Heavy (react-markdown + remark-gfm + micromark) — only ever imported
// lazily via MarkdownText so it stays out of the main bundle.
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];

const components: Components = {
  a(props) {
    const { node, ...rest } = props;
    void node;
    return <a {...rest} target="_blank" rel="noopener noreferrer" />;
  }
};

export default function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {text}
    </ReactMarkdown>
  );
}
