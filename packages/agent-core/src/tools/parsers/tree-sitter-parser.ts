/**
 * Tree-sitter Parser for Code Analysis Tools
 *
 * Independent implementation for agent-core code:* tools.
 * Similar to mind-engine's TreeSitterParser but simplified for agent use.
 *
 * Features:
 * - Lazy loading (tree-sitter loaded only when needed)
 * - Graceful fallback if tree-sitter not available
 * - Multi-language support (TypeScript, JavaScript, Python, Go, Rust)
 * - AST-based code analysis for find-definition, find-usages, outline
 */

/**
 * Code structure extracted from AST
 */
export interface CodeStructure {
  /** Functions found in code */
  functions: Array<{
    name: string;
    startLine: number;
    endLine: number;
    signature?: string;
  }>;

  /** Classes found in code */
  classes: Array<{
    name: string;
    startLine: number;
    endLine: number;
    methods?: string[];
  }>;

  /** Interfaces found in code */
  interfaces: Array<{
    name: string;
    startLine: number;
    endLine: number;
  }>;

  /** Type aliases found in code */
  types: Array<{
    name: string;
    startLine: number;
    endLine: number;
  }>;

  /** Variables/constants found in code */
  variables: Array<{
    name: string;
    startLine: number;
    endLine: number;
    kind: 'const' | 'let' | 'var';
  }>;

  /** Import statements */
  imports: Array<{
    source: string;
    imported?: string[];
    line: number;
  }>;

  /** Export statements */
  exports: Array<{
    name: string;
    type: 'function' | 'class' | 'const' | 'type' | 'interface' | 'default';
    line: number;
  }>;
}

/**
 * Symbol definition info
 */
export interface SymbolDefinition {
  name: string;
  type: 'class' | 'function' | 'variable' | 'type' | 'interface' | 'method' | 'property';
  startLine: number;
  endLine: number;
  signature?: string;
  exported: boolean;
}

/**
 * Symbol usage info
 */
export interface SymbolUsage {
  line: number;
  column: number;
  context: string;
  isDefinition: boolean;
}

/**
 * Tree-sitter parser with lazy loading and graceful fallback
 */
export class TreeSitterCodeParser {
  private parser: any = null;
  private isLoaded = false;
  private loadError: Error | null = null;
  private language: string;

  constructor(language: string) {
    this.language = language.toLowerCase();
  }

  /**
   * Check if parser is available
   */
  isAvailable(): boolean {
    if (!this.isLoaded) {
      // Trigger async load for next time
      this.loadParser().catch(() => {});
      return false;
    }
    return this.parser !== null;
  }

  /**
   * Get load error if any
   */
  getLoadError(): Error | null {
    return this.loadError;
  }

  /**
   * Lazy load Tree-sitter parser and language grammar
   * 
   * Dynamically imports tree-sitter and the appropriate language grammar based on
   * the language specified in the constructor. This method is idempotent - subsequent
   * calls will return the cached result without re-loading.
   * 
   * @returns Promise that resolves to `true` if parser loaded successfully, `false` otherwise
   * 
   * @remarks
   * - First call triggers dynamic import of tree-sitter and language grammar
   * - Subsequent calls return cached result immediately
   * - Supports: TypeScript, TSX, JavaScript, JSX, Python, Go, Rust
   * - If grammar not found or import fails, sets `loadError` and returns `false`
   * - Use `getLoadError()` to retrieve error details after failed load
   * 
   * @example
   * ```typescript
   * const parser = new TreeSitterCodeParser('typescript');
   * const loaded = await parser.loadParser();
   * if (!loaded) {
   *   console.error('Failed to load parser:', parser.getLoadError());
   * }
   * ```
   */
  async loadParser(): Promise<boolean> {
    if (this.isLoaded) {
      return this.parser !== null;
    }

    try {
      // Try to dynamically import tree-sitter
      const Parser = await import('tree-sitter').then(m => m.default || m);
      this.parser = new Parser();

      // Load language grammar
      const grammar = await this.loadGrammar(this.language);
      if (grammar) {
        this.parser.setLanguage(grammar);
        this.isLoaded = true;
        return true;
      }

      this.loadError = new Error(`Grammar not found for language: ${this.language}`);
      this.isLoaded = true;
      return false;
    } catch (error) {
      this.loadError = error instanceof Error ? error : new Error(String(error));
      this.isLoaded = true;
      return false;
    }
  }

  /**
   * Load language grammar
   */
  private async loadGrammar(lang: string): Promise<any> {
    try {
      switch (lang) {
        case 'typescript':
        case 'tsx':
          const ts = await import('tree-sitter-typescript');
          return lang === 'tsx' ? ts.tsx : ts.typescript;

        case 'javascript':
        case 'jsx':
          const js = await import('tree-sitter-javascript');
          return js.default || js;

        case 'python':
          const py = await import('tree-sitter-python');
          return py.default || py;

        case 'go':
          const go = await import('tree-sitter-go');
          return go.default || go;

        case 'rust':
          const rust = await import('tree-sitter-rust');
          return rust.default || rust;

        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  /**
   * Extract code structure from source code
   */
  extractStructure(code: string): CodeStructure {
    if (!this.parser) {
      // Fallback to regex-based parsing
      return this.extractStructureRegex(code);
    }

    try {
      const tree = this.parser.parse(code);
      const structure: CodeStructure = {
        functions: [],
        classes: [],
        interfaces: [],
        types: [],
        variables: [],
        imports: [],
        exports: [],
      };

      this.traverseAST(tree.rootNode, code, (node: any) => {
        // Extract functions
        if (this.isFunctionNode(node.type)) {
          const name = this.extractNodeName(node, code);
          if (name) {
            structure.functions.push({
              name,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              signature: this.extractSignature(node, code),
            });
          }
        }

        // Extract classes
        if (this.isClassNode(node.type)) {
          const name = this.extractNodeName(node, code);
          if (name) {
            const methods = this.extractClassMethods(node, code);
            structure.classes.push({
              name,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              methods,
            });
          }
        }

        // Extract interfaces
        if (node.type === 'interface_declaration') {
          const name = this.extractNodeName(node, code);
          if (name) {
            structure.interfaces.push({
              name,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
            });
          }
        }

        // Extract type aliases
        if (node.type === 'type_alias_declaration') {
          const name = this.extractNodeName(node, code);
          if (name) {
            structure.types.push({
              name,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
            });
          }
        }

        // Extract variables
        if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
          const kind = this.extractDeclarationKind(node, code);
          const names = this.extractVariableNames(node, code);
          for (const name of names) {
            structure.variables.push({
              name,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              kind,
            });
          }
        }

        // Extract imports
        if (node.type === 'import_statement') {
          const source = this.extractImportSource(node, code);
          if (source) {
            structure.imports.push({
              source,
              imported: this.extractImportedNames(node, code),
              line: node.startPosition.row + 1,
            });
          }
        }

        // Extract exports
        if (node.type.includes('export')) {
          const exportInfo = this.extractExportInfo(node, code);
          if (exportInfo) {
            structure.exports.push(exportInfo);
          }
        }
      });

      return structure;
    } catch {
      return this.extractStructureRegex(code);
    }
  }

  /**
   * Find all definitions of a symbol
   */
  findDefinitions(code: string, symbolName: string): SymbolDefinition[] {
    if (!this.parser) {
      return this.findDefinitionsRegex(code, symbolName);
    }

    try {
      const tree = this.parser.parse(code);
      const definitions: SymbolDefinition[] = [];

      this.traverseAST(tree.rootNode, code, (node: any) => {
        const name = this.extractNodeName(node, code);
        if (name !== symbolName) return;

        let type: SymbolDefinition['type'] | null = null;

        if (this.isClassNode(node.type)) {
          type = 'class';
        } else if (this.isFunctionNode(node.type)) {
          type = 'function';
        } else if (node.type === 'interface_declaration') {
          type = 'interface';
        } else if (node.type === 'type_alias_declaration') {
          type = 'type';
        } else if (node.type === 'method_definition' || node.type === 'method_signature') {
          type = 'method';
        } else if (node.type === 'public_field_definition' || node.type === 'property_signature') {
          type = 'property';
        } else if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
          type = 'variable';
        }

        if (type) {
          definitions.push({
            name,
            type,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            signature: this.extractSignature(node, code),
            exported: this.isExported(node),
          });
        }
      });

      return definitions;
    } catch {
      return this.findDefinitionsRegex(code, symbolName);
    }
  }

  /**
   * Find all usages of a symbol in source code
   * 
   * Searches through the parsed AST to locate all occurrences of a symbol (variable,
   * function, class, etc.) and returns detailed information about each usage including
   * line number, column position, context, and whether it's a definition or reference.
   * 
   * @param code - Source code to search within
   * @param symbolName - Name of the symbol to find usages of
   * @returns Array of symbol usages with location and context information
   * 
   * @remarks
   * - Uses tree-sitter AST parsing for accurate symbol identification
   * - Falls back to regex-based search if parser is not available
   * - Identifies both definitions and references of the symbol
   * - Checks identifier and property_identifier nodes in the AST
   * - Returns empty array if parsing fails or symbol not found
   * - Each usage includes line number (1-indexed), column (1-indexed), and context line
   * 
   * @example
   * ```typescript
   * const parser = new TreeSitterCodeParser('typescript');
   * await parser.loadParser();
   * 
   * const code = `
   *   const myVar = 42;
   *   console.log(myVar);
   *   function test() { return myVar; }
   * `;
   * 
   * const usages = parser.findUsages(code, 'myVar');
   * // Returns:
   * // [
   * //   { line: 1, column: 9, context: 'const myVar = 42;', isDefinition: true },
   * //   { line: 2, column: 15, context: 'console.log(myVar);', isDefinition: false },
   * //   { line: 3, column: 30, context: 'function test() { return myVar; }', isDefinition: false }
   * // ]
   * ```
   */
  findUsages(code: string, symbolName: string): SymbolUsage[] {
    if (!this.parser) {
      return this.findUsagesRegex(code, symbolName);
    }

    try {
      const tree = this.parser.parse(code);
      const usages: SymbolUsage[] = [];
      const lines = code.split('\n');

      this.traverseAST(tree.rootNode, code, (node: any) => {
        // Check identifier nodes
        if (node.type === 'identifier' || node.type === 'property_identifier') {
          const nodeText = code.substring(node.startIndex, node.endIndex);
          if (nodeText === symbolName) {
            const line = node.startPosition.row;
            const isDefinition = this.isDefinitionNode(node.parent);

            usages.push({
              line: line + 1,
              column: node.startPosition.column + 1,
              context: lines[line]?.trim() || '',
              isDefinition,
            });
          }
        }
      });

      return usages;
    } catch {
      return this.findUsagesRegex(code, symbolName);
    }
  }

  /**
   * Get file outline (structure summary)
   */
  getOutline(code: string, maxDepth: number = 2): Array<{
    type: string;
    name: string;
    line: number;
    depth: number;
    children?: Array<{ type: string; name: string; line: number }>;
  }> {
    const structure = this.extractStructure(code);
    const outline: Array<{
      type: string;
      name: string;
      line: number;
      depth: number;
      children?: Array<{ type: string; name: string; line: number }>;
    }> = [];

    // Add imports first
    for (const imp of structure.imports) {
      outline.push({
        type: 'import',
        name: imp.source,
        line: imp.line,
        depth: 0,
      });
    }

    // Add classes with methods
    for (const cls of structure.classes) {
      const item: typeof outline[0] = {
        type: 'class',
        name: cls.name,
        line: cls.startLine,
        depth: 0,
      };

      if (maxDepth > 0 && cls.methods && cls.methods.length > 0) {
        item.children = cls.methods.map((method, i) => ({
          type: 'method',
          name: method,
          line: cls.startLine + i + 1, // Approximate
        }));
      }

      outline.push(item);
    }

    // Add interfaces
    for (const iface of structure.interfaces) {
      outline.push({
        type: 'interface',
        name: iface.name,
        line: iface.startLine,
        depth: 0,
      });
    }

    // Add type aliases
    for (const type of structure.types) {
      outline.push({
        type: 'type',
        name: type.name,
        line: type.startLine,
        depth: 0,
      });
    }

    // Add functions
    for (const func of structure.functions) {
      outline.push({
        type: 'function',
        name: func.name,
        line: func.startLine,
        depth: 0,
      });
    }

    // Add variables (const/let/var)
    for (const variable of structure.variables) {
      outline.push({
        type: variable.kind,
        name: variable.name,
        line: variable.startLine,
        depth: 0,
      });
    }

    // Sort by line number
    outline.sort((a, b) => a.line - b.line);

    return outline;
  }

  // ============================================
  // Helper methods for tree-sitter
  // ============================================

  private traverseAST(node: any, code: string, callback: (node: any) => void): void {
    callback(node);
    for (let i = 0; i < node.childCount; i++) {
      this.traverseAST(node.child(i), code, callback);
    }
  }

  private isFunctionNode(nodeType: string): boolean {
    return [
      'function_declaration',
      'function_definition',
      'arrow_function',
      'function_expression',
      'method_definition',
      'function_item', // Rust
      'func_literal',  // Go
    ].includes(nodeType);
  }

  private isClassNode(nodeType: string): boolean {
    return [
      'class_declaration',
      'class_definition',
      'struct_item',    // Rust
      'type_declaration', // Go
    ].includes(nodeType);
  }

  private isDefinitionNode(node: any): boolean {
    if (!node) return false;
    return [
      'function_declaration',
      'class_declaration',
      'interface_declaration',
      'type_alias_declaration',
      'lexical_declaration',
      'variable_declaration',
      'method_definition',
      'public_field_definition',
      'property_signature',
      'parameter',
    ].includes(node.type);
  }

  private isExported(node: any): boolean {
    // Check if parent is export statement
    let current = node.parent;
    while (current) {
      if (current.type === 'export_statement') {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  private extractNodeName(node: any, code: string): string | undefined {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      return code.substring(nameNode.startIndex, nameNode.endIndex);
    }
    return undefined;
  }

  private extractSignature(node: any, code: string): string {
    // Get first line of node as signature
    const text = code.substring(node.startIndex, node.endIndex);
    const firstLine = text.split('\n')[0] || '';
    // Clean up and truncate
    return firstLine.trim().substring(0, 200);
  }

  private extractClassMethods(node: any, code: string): string[] {
    const methods: string[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'class_body') {
        for (let j = 0; j < child.childCount; j++) {
          const member = child.child(j);
          if (member.type === 'method_definition') {
            const name = this.extractNodeName(member, code);
            if (name) methods.push(name);
          }
        }
      }
    }
    return methods;
  }

  private extractDeclarationKind(node: any, code: string): 'const' | 'let' | 'var' {
    const text = code.substring(node.startIndex, node.startIndex + 5);
    if (text.startsWith('const')) return 'const';
    if (text.startsWith('let')) return 'let';
    return 'var';
  }

  private extractVariableNames(node: any, code: string): string[] {
    const names: string[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'variable_declarator') {
        const name = this.extractNodeName(child, code);
        if (name) names.push(name);
      }
    }
    return names;
  }

  private extractImportSource(node: any, code: string): string | undefined {
    const sourceNode = node.childForFieldName('source');
    if (sourceNode) {
      const source = code.substring(sourceNode.startIndex, sourceNode.endIndex);
      return source.replace(/['"]/g, '');
    }
    return undefined;
  }

  private extractImportedNames(node: any, code: string): string[] {
    const names: string[] = [];
    this.traverseAST(node, code, (child: any) => {
      if (child.type === 'import_specifier') {
        const name = this.extractNodeName(child, code);
        if (name) names.push(name);
      }
    });
    return names;
  }

  private extractExportInfo(node: any, code: string): CodeStructure['exports'][0] | null {
    let name: string | undefined;
    let type: CodeStructure['exports'][0]['type'] = 'const';

    // Check for default export
    if (node.type === 'export_statement') {
      const text = code.substring(node.startIndex, node.endIndex);
      if (text.includes('default')) {
        type = 'default';
        // Try to extract name from default export
        name = 'default';
      }
    }

    // Look for declaration inside export
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'function_declaration') {
        name = this.extractNodeName(child, code);
        type = 'function';
      } else if (child.type === 'class_declaration') {
        name = this.extractNodeName(child, code);
        type = 'class';
      } else if (child.type === 'type_alias_declaration') {
        name = this.extractNodeName(child, code);
        type = 'type';
      } else if (child.type === 'interface_declaration') {
        name = this.extractNodeName(child, code);
        type = 'interface';
      } else if (child.type === 'lexical_declaration') {
        const names = this.extractVariableNames(child, code);
        if (names[0]) {
          name = names[0];
          type = 'const';
        }
      }
    }

    if (name) {
      return {
        name,
        type,
        line: node.startPosition.row + 1,
      };
    }

    return null;
  }

  // ============================================
  // Regex fallback methods
  // ============================================

  private extractStructureRegex(code: string): CodeStructure {
    const lines = code.split('\n');
    const structure: CodeStructure = {
      functions: [],
      classes: [],
      interfaces: [],
      types: [],
      variables: [],
      imports: [],
      exports: [],
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || '';
      const trimmed = line.trim();

      // Functions
      const funcMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (funcMatch) {
        structure.functions.push({
          name: funcMatch[1] || 'anonymous',
          startLine: i + 1,
          endLine: this.findBlockEnd(lines, i),
          signature: trimmed,
        });
      }

      // Arrow functions assigned to const
      const arrowMatch = trimmed.match(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/);
      if (arrowMatch) {
        structure.functions.push({
          name: arrowMatch[1] || 'anonymous',
          startLine: i + 1,
          endLine: this.findBlockEnd(lines, i),
          signature: trimmed,
        });
      }

      // Classes
      const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
      if (classMatch) {
        structure.classes.push({
          name: classMatch[1] || 'Anonymous',
          startLine: i + 1,
          endLine: this.findBlockEnd(lines, i),
        });
      }

      // Interfaces
      const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
      if (interfaceMatch) {
        structure.interfaces.push({
          name: interfaceMatch[1] || 'Anonymous',
          startLine: i + 1,
          endLine: this.findBlockEnd(lines, i),
        });
      }

      // Type aliases
      const typeMatch = trimmed.match(/^(?:export\s+)?type\s+(\w+)/);
      if (typeMatch) {
        structure.types.push({
          name: typeMatch[1] || 'Anonymous',
          startLine: i + 1,
          endLine: i + 1,
        });
      }

      // Variables
      const varMatch = trimmed.match(/^(?:export\s+)?(const|let|var)\s+(\w+)/);
      if (varMatch && !arrowMatch) {
        structure.variables.push({
          name: varMatch[2] || 'unknown',
          startLine: i + 1,
          endLine: i + 1,
          kind: varMatch[1] as 'const' | 'let' | 'var',
        });
      }

      // Imports
      const importMatch = trimmed.match(/^import\s+(?:\{[^}]+\}|[^;]+)\s+from\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        structure.imports.push({
          source: importMatch[1] || '',
          line: i + 1,
        });
      }

      // Exports
      if (trimmed.startsWith('export ')) {
        const exportMatch = trimmed.match(/export\s+(?:default\s+)?(?:(const|let|var|function|class|type|interface)\s+)?(\w+)/);
        if (exportMatch) {
          structure.exports.push({
            name: exportMatch[2] || '',
            type: this.inferExportType(exportMatch[1]),
            line: i + 1,
          });
        }
      }
    }

    return structure;
  }

  private findDefinitionsRegex(code: string, symbolName: string): SymbolDefinition[] {
    const definitions: SymbolDefinition[] = [];
    const lines = code.split('\n');

    const patterns: Array<{ regex: RegExp; type: SymbolDefinition['type'] }> = [
      { regex: new RegExp(`^\\s*(?:export\\s+)?(?:abstract\\s+)?class\\s+${symbolName}\\b`), type: 'class' },
      { regex: new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${symbolName}\\s*[(<]`), type: 'function' },
      { regex: new RegExp(`^\\s*(?:export\\s+)?const\\s+${symbolName}\\s*=\\s*(?:async\\s+)?(?:\\([^)]*\\)|[^=])\\s*=>`), type: 'function' },
      { regex: new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${symbolName}\\s*[=:]`), type: 'variable' },
      { regex: new RegExp(`^\\s*(?:export\\s+)?type\\s+${symbolName}\\b`), type: 'type' },
      { regex: new RegExp(`^\\s*(?:export\\s+)?interface\\s+${symbolName}\\b`), type: 'interface' },
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || '';
      for (const { regex, type } of patterns) {
        if (regex.test(line)) {
          definitions.push({
            name: symbolName,
            type,
            startLine: i + 1,
            endLine: this.findBlockEnd(lines, i),
            signature: line.trim(),
            exported: line.includes('export'),
          });
          break;
        }
      }
    }

    return definitions;
  }

  private findUsagesRegex(code: string, symbolName: string): SymbolUsage[] {
    const usages: SymbolUsage[] = [];
    const lines = code.split('\n');
    const pattern = new RegExp(`\\b${symbolName}\\b`, 'g');

    const definitionPatterns = [
      new RegExp(`^\\s*(?:export\\s+)?(?:abstract\\s+)?class\\s+${symbolName}\\b`),
      new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${symbolName}\\s*[(<]`),
      new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${symbolName}\\s*[=:]`),
      new RegExp(`^\\s*(?:export\\s+)?type\\s+${symbolName}\\b`),
      new RegExp(`^\\s*(?:export\\s+)?interface\\s+${symbolName}\\b`),
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || '';
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(line)) !== null) {
        const isDefinition = definitionPatterns.some(p => p.test(line));

        usages.push({
          line: i + 1,
          column: match.index + 1,
          context: line.trim(),
          isDefinition,
        });
      }
    }

    return usages;
  }

  private findBlockEnd(lines: string[], start: number): number {
    let depth = 0;
    for (let i = start; i < lines.length; i++) {
      const line = lines[i] || '';
      for (const char of line) {
        if (char === '{') depth++;
        if (char === '}') depth--;
        if (depth === 0 && char === '}') {
          return i + 1;
        }
      }
    }
    return lines.length;
  }

  private inferExportType(keyword: string | undefined): CodeStructure['exports'][0]['type'] {
    switch (keyword) {
      case 'function': return 'function';
      case 'class': return 'class';
      case 'type': return 'type';
      case 'interface': return 'interface';
      case 'const':
      case 'let':
      case 'var':
      default:
        return 'const';
    }
  }
}

/**
 * Parser factory with caching
 */
const parserCache = new Map<string, TreeSitterCodeParser>();

/**
 * Get or create parser for language
 */
export function getParser(language: string): TreeSitterCodeParser {
  const lang = language.toLowerCase();

  if (!parserCache.has(lang)) {
    parserCache.set(lang, new TreeSitterCodeParser(lang));
  }

  return parserCache.get(lang)!;
}

/**
 * Detect language from file extension
 */
export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();

  switch (ext) {
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'py':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    default:
      return 'typescript'; // Default to TypeScript
  }
}
