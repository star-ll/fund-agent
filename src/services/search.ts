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
  const response = await axios.post(
    `${config.search.baseURL}/search`,
    { query, max_results: maxResults },
    { headers: { Authorization: `Bearer ${config.search.apiKey}` } },
  );
  return response.data;
}
