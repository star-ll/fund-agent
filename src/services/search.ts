import axios from 'axios';
import { config } from '../utils/config';

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

export async function webSearch(query: string, maxResults = 5): Promise<SearchResponse> {
  const headers: Record<string, string> = {};
  if (config.search.apiKey) {
    headers['Authorization'] = `Bearer ${config.search.apiKey}`;
  }
  const response = await axios.post(
    `${config.search.baseURL}/search`,
    { query, max_results: maxResults },
    { headers },
  );
  return response.data;
}
