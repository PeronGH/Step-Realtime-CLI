import { Text, Box } from 'ink';
import { marked, type Token, type Tokens } from 'marked';
import { highlight } from 'cli-highlight';
import type React from 'react';

/**
 * markdown 终端渲染（marked lexer + cli-highlight + chalk/Ink 样式）。
 * 把 assistant 的 markdown 文本渲染成 Ink <Text> 树。
 * transient=true（流式中）时关语法高亮（避免闪烁与开销），完成后重渲染上高亮。
 */

let key = 0;
function k(): number {
  return key++;
}

/** 行内 token → React 节点（加粗/斜体/行内码/删除线/链接）。 */
function renderInline(tokens: Token[] | undefined, transient: boolean): React.ReactNode[] {
  if (tokens === undefined) return [];
  const out: React.ReactNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'strong':
        out.push(
          <Text key={k()} bold>
            {renderInline((t as Tokens.Strong).tokens, transient)}
          </Text>,
        );
        break;
      case 'em':
        out.push(
          <Text key={k()} italic>
            {renderInline((t as Tokens.Em).tokens, transient)}
          </Text>,
        );
        break;
      case 'codespan':
        out.push(
          <Text key={k()} color="cyan" backgroundColor="#2a2a2a">
            {(t as Tokens.Codespan).text}
          </Text>,
        );
        break;
      case 'del':
        out.push(
          <Text key={k()} strikethrough>
            {renderInline((t as Tokens.Del).tokens, transient)}
          </Text>,
        );
        break;
      case 'link': {
        const link = t as Tokens.Link;
        out.push(
          <Text key={k()} color="blue" underline>
            {renderInline(link.tokens, transient)}
            <Text color="gray">({link.href})</Text>
          </Text>,
        );
        break;
      }
      case 'text':
        out.push(<Text key={k()}>{(t as Tokens.Text).text}</Text>);
        break;
      case 'escape':
        out.push(<Text key={k()}>{(t as Tokens.Escape).text}</Text>);
        break;
      default:
        out.push(<Text key={k()}>{'raw' in t ? (t.raw as string) : ''}</Text>);
    }
  }
  return out;
}

/** 代码块高亮（transient 时跳过，直接返回原文）。 */
function highlightCode(code: string, lang: string | undefined, transient: boolean): string {
  if (transient) return code;
  try {
    return highlight(code, { language: lang !== undefined && lang !== '' ? lang : 'text', ignoreIllegals: true });
  } catch {
    return code;
  }
}

/** 块级 token → React 节点。 */
function renderBlock(t: Token, transient: boolean): React.ReactNode {
  switch (t.type) {
    case 'heading': {
      const h = t as Tokens.Heading;
      const prefix = h.depth <= 2 ? '' : '#'.repeat(h.depth) + ' ';
      return (
        <Text key={k()} bold color="magenta" underline={h.depth === 1}>
          {prefix}
          {renderInline(h.tokens, transient)}
        </Text>
      );
    }
    case 'paragraph':
      return <Text key={k()}>{renderInline((t as Tokens.Paragraph).tokens, transient)}</Text>;
    case 'code': {
      const c = t as Tokens.Code;
      return (
        <Box key={k()} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          {c.lang !== undefined && c.lang !== '' ? <Text color="gray">{c.lang}</Text> : null}
          <Text>{highlightCode(c.text, c.lang, transient)}</Text>
        </Box>
      );
    }
    case 'list': {
      const l = t as Tokens.List;
      return (
        <Box key={k()} flexDirection="column">
          {l.items.map((item, i) => {
            const marker = l.ordered ? `${(l.start as number) + i}. ` : '• ';
            const task = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';
            return (
              <Text key={k()}>
                {marker}
                {task}
                {renderInline(item.tokens, transient)}
              </Text>
            );
          })}
        </Box>
      );
    }
    case 'blockquote':
      return (
        <Text key={k()} color="gray" italic>
          {'│ '}
          {(t as Tokens.Blockquote).text}
        </Text>
      );
    case 'hr':
      return (
        <Text key={k()} color="gray">
          {'─'.repeat(40)}
        </Text>
      );
    case 'space':
      return <Text key={k()}> </Text>;
    default:
      return 'text' in t && typeof (t as { text?: string }).text === 'string' ? (
        <Text key={k()}>{(t as { text: string }).text}</Text>
      ) : null;
  }
}

/** 渲染 markdown 文本为 Ink 组件树。 */
export function Markdown({ text, transient = false }: { text: string; transient?: boolean }): React.ReactElement {
  key = 0;
  const tokens = marked.lexer(text);
  return (
    <Box flexDirection="column">
      {tokens.map((t) => renderBlock(t, transient))}
    </Box>
  );
}
