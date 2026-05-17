import axios from 'axios';
import { config } from './config';

export const akshareClient = axios.create({
  baseURL: config.akshare.baseURL,
  timeout: 120000,
});
