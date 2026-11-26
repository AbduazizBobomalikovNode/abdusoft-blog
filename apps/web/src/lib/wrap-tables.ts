const WRAPPED_OR_BARE_TABLE = /(<div class="table-scroll">)?(<table\b[\s\S]*?<\/table>)/g;

/**
 * Har bir `<table>`ni `.table-scroll` o'ramiga soladi, shunda keng jadval
 * sahifani emas, o'z o'ramini gorizontal aylantiradi. SSR HTML'da bajariladi
 * (gidratsiyaga bog'liq emas). Idempotent: allaqachon o'ralgan jadval qayta o'ralmaydi.
 */
export function wrapTables(html: string): string {
  return html.replace(WRAPPED_OR_BARE_TABLE, (match, wrapper: string | undefined, table: string) =>
    wrapper ? match : `<div class="table-scroll">${table}</div>`,
  );
}
