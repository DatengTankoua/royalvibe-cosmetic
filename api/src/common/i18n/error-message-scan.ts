import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import * as ts from 'typescript';

/**
 * 1-16G — Relevé statique des messages d'erreur renvoyés par l'API (outil de
 * contrôle, utilisé par les tests ; jamais chargé par l'application).
 *
 * Relève, dans `src/**` hors tests :
 * - les chaînes et gabarits passés à `new *Exception(...)` ;
 * - toute propriété `message:` d'un objet littéral (corps d'erreur
 *   construits par des fonctions intermédiaires, décorateurs de
 *   validation `@IsString({ message: ... })`) ;
 * - les chaînes passées aux fonctions intermédiaires d'erreur
 *   (`required("…")`) ;
 * - les constantes exportées dont le nom finit par `_MESSAGE`.
 * Un gabarit est rendu avec `${…}` pour chaque variable.
 */
export interface ScannedMessage {
  file: string;
  line: number;
  text: string;
  template: boolean;
}

const SRC = join(__dirname, '..', '..');

/** Fonctions qui construisent une exception à partir d'un message. */
const ERROR_HELPERS = new Set(['required']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'migrations') walk(full, out);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function literalTexts(node: ts.Node): { text: string; template: boolean }[] {
  if (ts.isConditionalExpression(node)) {
    return [...literalTexts(node.whenTrue), ...literalTexts(node.whenFalse)];
  }
  if (ts.isParenthesizedExpression(node)) return literalTexts(node.expression);
  const value = literalText(node);
  return value ? [value] : [];
}

function literalText(
  node: ts.Node,
): { text: string; template: boolean } | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { text: node.text, template: false };
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) text += '${…}' + span.literal.text;
    return { text, template: true };
  }
  return null;
}

function isExceptionCall(node: ts.Node): node is ts.NewExpression {
  return (
    ts.isNewExpression(node) &&
    /Exception$/.test(node.expression.getText()) &&
    !/^(Error|LegalArchiveError)$/.test(node.expression.getText())
  );
}

export function scanErrorMessages(root: string = SRC): ScannedMessage[] {
  const found: ScannedMessage[] = [];
  for (const file of walk(root)) {
    const source = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const add = (node: ts.Node, value: { text: string; template: boolean }) => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      found.push({
        file: relative(root, file).replace(/\\/g, '/'),
        line: line + 1,
        ...value,
      });
    };
    const fromObject = (obj: ts.ObjectLiteralExpression) => {
      for (const prop of obj.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          prop.name.getText(sf) === 'message'
        ) {
          for (const value of literalTexts(prop.initializer)) {
            add(prop.initializer, value);
          }
        }
      }
    };
    const visit = (node: ts.Node) => {
      if (isExceptionCall(node)) {
        for (const arg of node.arguments ?? []) {
          const value = literalText(arg);
          if (value) add(arg, value);
          else if (ts.isObjectLiteralExpression(arg)) fromObject(arg);
        }
      } else if (ts.isObjectLiteralExpression(node)) {
        fromObject(node);
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ERROR_HELPERS.has(node.expression.text)
      ) {
        for (const arg of node.arguments) {
          const value = literalText(arg);
          if (value) add(arg, value);
        }
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        /_MESSAGE$/.test(node.name.text) &&
        node.initializer
      ) {
        const value = literalText(node.initializer);
        if (value) add(node.initializer, value);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}
