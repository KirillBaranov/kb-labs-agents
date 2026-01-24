/**
 * Type declarations for tree-sitter and language grammars
 *
 * These are optional dependencies - if not installed,
 * the parser falls back to regex-based parsing.
 */

declare module "tree-sitter" {
  export interface Point {
    row: number;
    column: number;
  }

  export interface SyntaxNode {
    type: string;
    startPosition: Point;
    endPosition: Point;
    startIndex: number;
    endIndex: number;
    childCount: number;
    parent: SyntaxNode | null;
    child(index: number): SyntaxNode | null;
    childForFieldName(fieldName: string): SyntaxNode | null;
  }

  export interface Tree {
    rootNode: SyntaxNode;
  }

  export interface Language {}

  export default class Parser {
    setLanguage(language: Language): void;
    parse(input: string): Tree;
  }
}

declare module "tree-sitter-typescript" {
  import type { Language } from "tree-sitter";
  export const typescript: Language;
  export const tsx: Language;
}

declare module "tree-sitter-javascript" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-python" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-go" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}

declare module "tree-sitter-rust" {
  import type { Language } from "tree-sitter";
  const language: Language;
  export default language;
}
