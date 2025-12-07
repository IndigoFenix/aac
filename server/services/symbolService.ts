import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';

export interface MulberrySymbol {
  id: string;
  name: string;
  category: string;
  tags: string[];
  filename: string;
  categoryId: string;
  grammar?: string;
  rated: boolean;
}

export class SymbolService {
  private symbols: Map<string, MulberrySymbol> = new Map();
  private categories: Map<string, string> = new Map();
  private loaded = false;

  constructor() {
    this.loadSymbols();
  }

  private async loadSymbols(): Promise<void> {
    if (this.loaded) return;

    try {
      const csvPath = path.join(process.cwd(), 'attached_assets/mulberry-symbols/symbol-info.csv');
      const symbolsDir = path.join(process.cwd(), 'attached_assets/mulberry-symbols/symbols');
      
      if (!fs.existsSync(csvPath)) {
        console.warn('Mulberry symbols CSV not found');
        return;
      }

      const symbols: any[] = [];
      
      // Parse CSV
      await new Promise((resolve, reject) => {
        fs.createReadStream(csvPath)
          .pipe(csv())
          .on('data', (row: any) => symbols.push(row))
          .on('end', resolve)
          .on('error', reject);
      });

      console.log(`Loading ${symbols.length} Mulberry symbols...`);

      // Process symbols
      for (const row of symbols) {
        const symbolName = row['symbol-en'];
        const categoryName = row['category-en'];
        const tags = row.tags ? row.tags.split(',').map((t: string) => t.trim()) : [];
        
        // Generate filename (Mulberry symbols are already processed in CSV)
        const filename = symbolName + '.svg';

        // Check if SVG file exists
        const svgPath = path.join(symbolsDir, filename);
        if (fs.existsSync(svgPath)) {
          const symbol: MulberrySymbol = {
            id: row['symbol-id'],
            name: symbolName,
            category: categoryName,
            tags,
            filename,
            categoryId: row['category-id'],
            grammar: row.grammar,
            rated: row.rated === '1'
          };

          this.symbols.set(symbolName.toLowerCase(), symbol);
          this.categories.set(row['category-id'], categoryName);
        }
      }

      this.loaded = true;
      console.log(`✓ Loaded ${this.symbols.size} Mulberry symbols with ${this.categories.size} categories`);

    } catch (error) {
      console.error('Error loading Mulberry symbols:', error);
    }
  }

  // Search symbols by keyword
  public async searchSymbols(query: string, limit: number = 20): Promise<MulberrySymbol[]> {
    await this.loadSymbols();
    
    const queryLower = query.toLowerCase();
    const results: MulberrySymbol[] = [];

    for (const symbol of Array.from(this.symbols.values())) {
      if (results.length >= limit) break;

      // Search in name, category, and tags
      const matchesName = symbol.name.toLowerCase().includes(queryLower);
      const matchesCategory = symbol.category.toLowerCase().includes(queryLower);
      const matchesTags = symbol.tags.some((tag: string) => tag.toLowerCase().includes(queryLower));

      if (matchesName || matchesCategory || matchesTags) {
        results.push(symbol);
      }
    }

    // Sort by relevance (exact name matches first)
    results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === queryLower ? 1 : 0;
      const bExact = b.name.toLowerCase() === queryLower ? 1 : 0;
      
      if (aExact !== bExact) return bExact - aExact;
      
      const aStarts = a.name.toLowerCase().startsWith(queryLower) ? 1 : 0;
      const bStarts = b.name.toLowerCase().startsWith(queryLower) ? 1 : 0;
      
      return bStarts - aStarts;
    });

    return results;
  }

  // Get symbol by name
  public async getSymbol(name: string): Promise<MulberrySymbol | null> {
    await this.loadSymbols();
    return this.symbols.get(name.toLowerCase()) || null;
  }

  // Get symbols by category
  public async getSymbolsByCategory(categoryName: string, limit: number = 50): Promise<MulberrySymbol[]> {
    await this.loadSymbols();
    
    const results: MulberrySymbol[] = [];
    
    for (const symbol of Array.from(this.symbols.values())) {
      if (results.length >= limit) break;
      
      if (symbol.category.toLowerCase().includes(categoryName.toLowerCase())) {
        results.push(symbol);
      }
    }

    return results;
  }

  // Get all categories
  public async getCategories(): Promise<Array<{id: string, name: string}>> {
    await this.loadSymbols();
    
    return Array.from(this.categories.entries()).map(([id, name]) => ({
      id,
      name
    }));
  }

  // Get symbol SVG content
  public async getSymbolSvg(filename: string): Promise<string | null> {
    try {
      const symbolsDir = path.join(process.cwd(), 'attached_assets/mulberry-symbols/symbols');
      const svgPath = path.join(symbolsDir, filename);
      
      if (fs.existsSync(svgPath)) {
        return fs.readFileSync(svgPath, 'utf8');
      }
      
      return null;
    } catch (error) {
      console.error('Error reading symbol SVG:', error);
      return null;
    }
  }

  // Get random symbols for suggestions
  public async getRandomSymbols(count: number = 10): Promise<MulberrySymbol[]> {
    await this.loadSymbols();
    
    const allSymbols = Array.from(this.symbols.values());
    const shuffled = allSymbols.sort(() => 0.5 - Math.random());
    
    return shuffled.slice(0, count);
  }
}

// Export singleton instance
export const symbolService = new SymbolService();