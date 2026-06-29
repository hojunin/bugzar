import type { DesignElement } from '../report/types';

/** A structured, paste-into-an-AI description of one annotated element. */
export function formatForAI(el: DesignElement, i: number): string {
  const lines = [`[Design QA #${i + 1}]`];
  lines.push(`Element: <${el.tagName}${el.cssClasses ? ` class="${el.cssClasses}"` : ''}>`);
  lines.push(`Selector: ${el.selector}`);
  if (el.componentName) lines.push(`Component: ${el.componentName}`);
  if (el.textContent) lines.push(`Text: "${el.textContent}"`);
  if (el.attributes && Object.keys(el.attributes).length > 0) {
    const attrs = Object.entries(el.attributes)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    lines.push(`Attributes: ${attrs}`);
  }
  lines.push(`Fix requested: ${el.userNote || '(none)'}`);
  if (el.figmaUrl) lines.push(`Figma: ${el.figmaUrl}`);
  return lines.join('\n');
}

export function formatAll(elements: DesignElement[], pageUrl?: string): string {
  const header = pageUrl ? `Design QA report — ${pageUrl}` : 'Design QA report';
  return [header, '', elements.map((el, i) => formatForAI(el, i)).join('\n\n')].join('\n');
}
