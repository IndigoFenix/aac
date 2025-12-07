import fetch from "node-fetch";
//import * as cheerio from 'cheerio';

export interface SearchItem {
  title: string;
  snippet: string;
  link: string;
}

export interface ArticleResponse {
  title?: string | null;
  content?: string;
}

export async function webSearch(
  query: string,
  engine: string = "google",
  num: number = 5
): Promise<SearchItem[]> {
  if (engine === "google") {
    // Google Custom Search
    console.log("Running custom search");
    const key = process.env.GOOGLE_CSE_KEY!;
    const cx = process.env.GOOGLE_CSE_CX!;
    const url =
      `https://www.googleapis.com/customsearch/v1?key=${key}` +
      `&cx=${cx}&q=${encodeURIComponent(query)}&num=${num}`;

    const response = await fetch(url);
    const data = await response.json() as any;
    console.log("Search data:", data);
    const items: SearchItem[] = (data.items || []).map((i: any) => ({
      title: i.title,
      snippet: i.snippet,
      link: i.link,
    }));
    return items || [];
  }

  // Future: else if engine==='bing' or others…
  throw new Error("Unsupported search engine");
}

export async function fetchPage(url: string): Promise<ArticleResponse|null> {
  try {
    throw new Error("fetchPage is disabled for now");
    /*
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MyBot/1.0)' },
      redirect: 'follow',
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const $ = cheerio.load(html);
    $('script, style, nav, header, footer, aside, form').remove();

    const paragraphs = $('p').map((i, el) => $(el).text().trim()).get().filter(Boolean);
    const content = paragraphs.join('\n\n').slice(0, 20000);

    const title = $('title').first().text().trim() || url;

    return { title, content };
    */
  } catch (err) {
    console.error('Cheerio parsing error:', err);
    return null;
  }
}
