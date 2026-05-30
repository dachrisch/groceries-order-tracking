import { Request, Response } from 'express';
import { handleGetInventory } from './src/api/controllers/inventory.controller';

const mockReq = { userId: 'mock-user-id', cookies: { dkey: 'mock-dkey' } } as any;
const mockRes = { 
  json: (data: any) => console.log('Response:', JSON.stringify(data, null, 2)),
  status: (code: number) => ({ json: (data: any) => console.error('Status:', code, data) })
} as any;

handleGetInventory(mockReq, mockRes);
