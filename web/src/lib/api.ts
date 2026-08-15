import axios from "axios";
import { getToken } from "./auth";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ApiUser {
  _id: string;
  name: string;
  email: string;
  role: "admin" | "seller";
  createdAt: string;
}

export interface ApiSection {
  _id: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface ApiProduct {
  _id: string;
  sectionId: string;
  name: string;
  imageUrl: string;
  purchasePrice: number;
  salePrice: number;
  initialQuantity: number;
  remainingQuantity: number;
  createdAt: string;
  updatedAt: string;
  // computed metrics returned by backend
  status: "in_stock" | "low_stock" | "out_of_stock";
  unitsSold: number;
  totalPurchaseCost: number;
  estimatedRevenue: number;
  estimatedProfit: number;
}

export interface ApiProductDetail extends ApiProduct {
  actualRevenue: number;
  actualProfit: number;
  sales: ApiSale[];
  auditLogs: ApiAuditLog[];
}

export interface ApiSale {
  _id: string;
  productId: string | { _id: string; name: string };
  quantity: number;
  salePrice: number;
  sellerId: { _id: string; name: string; email: string };
  buyerName?: string;
  buyerContact?: string;
  createdAt: string;
}

export interface ApiAuditLog {
  _id: string;
  productId: string;
  action: string;
  actorId: { _id: string; name: string; email: string };
  details: Record<string, unknown>;
  createdAt: string;
}

export interface AnalyticsOverview {
  totalInvested: number;
  totalRevenue: number;
  netProfit: number;
  avgMargin: number;
  unitsSold: number;
  totalTransactions: number;
  productsCount: number;
  lowStockCount: number;
  outOfStockCount: number;
}

export interface ProductRanking {
  productId: string;
  productName: string;
  imageUrl: string;
  remainingQuantity: number;
  totalUnitsSold: number;
  totalRevenue: number;
  netProfit: number;
  transactionCount: number;
}

export interface SellerRanking {
  sellerId: string;
  sellerName: string;
  sellerEmail: string;
  totalUnitsSold: number;
  totalRevenue: number;
  transactionCount: number;
}

export interface MonthlyTrend {
  period: string;
  totalRevenue: number;
  totalUnitsSold: number;
  transactionCount: number;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
});

apiClient.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function authRegister(payload: {
  name: string;
  email: string;
  password: string;
}): Promise<{ access_token: string; user: ApiUser }> {
  const { data } = await apiClient.post("/auth/register", payload);
  return data;
}

export async function authLogin(payload: {
  email: string;
  password: string;
}): Promise<{ access_token: string; user: ApiUser }> {
  const { data } = await apiClient.post("/auth/login", payload);
  return data;
}

export async function fetchMe(): Promise<ApiUser> {
  const { data } = await apiClient.get<ApiUser>("/auth/me");
  return data;
}

// ─── Sections ────────────────────────────────────────────────────────────────

export async function fetchSections(): Promise<ApiSection[]> {
  const { data } = await apiClient.get<ApiSection[]>("/sections");
  return data;
}

export async function fetchSection(id: string): Promise<ApiSection> {
  const { data } = await apiClient.get<ApiSection>(`/sections/${id}`);
  return data;
}

export async function createSection(payload: {
  name: string;
  description?: string;
}): Promise<ApiSection> {
  const { data } = await apiClient.post<ApiSection>("/sections", payload);
  return data;
}

export async function updateSection(
  id: string,
  payload: { name?: string; description?: string },
): Promise<ApiSection> {
  const { data } = await apiClient.patch<ApiSection>(
    `/sections/${id}`,
    payload,
  );
  return data;
}

export async function deleteSection(id: string): Promise<void> {
  await apiClient.delete(`/sections/${id}`);
}

// ─── Products ────────────────────────────────────────────────────────────────

export async function fetchProducts(sectionId?: string): Promise<ApiProduct[]> {
  const { data } = await apiClient.get<
    {
      product: ApiProduct;
      status: string;
      unitsSold: number;
      totalPurchaseCost: number;
      estimatedRevenue: number;
      estimatedProfit: number;
    }[]
  >("/products", { params: sectionId ? { sectionId } : {} });
  // Flatten backend's { product, ...metrics } shape
  return data.map(
    ({ product, ...metrics }) => ({ ...product, ...metrics }) as ApiProduct,
  );
}

export async function fetchProduct(id: string): Promise<ApiProductDetail> {
  const { data } = await apiClient.get<{
    product: ApiProduct;
    status: string;
    unitsSold: number;
    totalPurchaseCost: number;
    estimatedRevenue: number;
    estimatedProfit: number;
    actualRevenue: number;
    actualProfit: number;
    sales: ApiSale[];
    auditLogs: ApiAuditLog[];
  }>(`/products/${id}`);
  const { product, ...rest } = data;
  return { ...product, ...rest } as ApiProductDetail;
}

export async function createProduct(payload: {
  sectionId: string;
  name: string;
  purchasePrice: number;
  salePrice: number;
  initialQuantity: number;
  image: File;
}): Promise<ApiProduct> {
  const form = new FormData();
  form.append("sectionId", payload.sectionId);
  form.append("name", payload.name);
  form.append("purchasePrice", String(payload.purchasePrice));
  form.append("salePrice", String(payload.salePrice));
  form.append("initialQuantity", String(payload.initialQuantity));
  form.append("image", payload.image);
  const { data } = await apiClient.post<ApiProduct>("/products", form);
  return data;
}

export async function updateProduct(
  id: string,
  payload: {
    name?: string;
    purchasePrice?: number;
    salePrice?: number;
    additionalStock?: number;
    sectionId?: string;
  },
): Promise<ApiProduct> {
  const { data } = await apiClient.patch<{
    product: ApiProduct;
    status: string;
    unitsSold: number;
    totalPurchaseCost: number;
    estimatedRevenue: number;
    estimatedProfit: number;
  }>(`/products/${id}`, payload);
  const { product, ...metrics } = data;
  return { ...product, ...metrics } as ApiProduct;
}

export async function deleteProduct(id: string): Promise<void> {
  await apiClient.delete(`/products/${id}`);
}

// ─── Trash ───────────────────────────────────────────────────────────────────

export interface ApiTrashedSection extends ApiSection {
  deletedAt: string;
}
export interface ApiTrashedProduct {
  _id: string;
  sectionId: string;
  name: string;
  imageUrl: string;
  purchasePrice: number;
  salePrice: number;
  initialQuantity: number;
  remainingQuantity: number;
  deletedAt: string;
  createdAt: string;
}

export async function fetchTrash(): Promise<{
  sections: ApiTrashedSection[];
  products: ApiTrashedProduct[];
}> {
  const { data } = await apiClient.get("/trash");
  return data;
}

export async function restoreSection(id: string): Promise<ApiSection> {
  const { data } = await apiClient.patch<ApiSection>(`/sections/${id}/restore`);
  return data;
}

export async function permanentDeleteSection(id: string): Promise<void> {
  await apiClient.delete(`/sections/${id}/permanent`);
}

export async function restoreProduct(id: string): Promise<void> {
  await apiClient.patch(`/products/${id}/restore`);
}

export async function permanentDeleteProduct(id: string): Promise<void> {
  await apiClient.delete(`/products/${id}/permanent`);
}

// ─── Sales ───────────────────────────────────────────────────────────────────

export async function fetchSales(productId?: string): Promise<ApiSale[]> {
  const { data } = await apiClient.get<ApiSale[]>("/sales", {
    params: productId ? { productId } : {},
  });
  return data;
}

export async function createSale(payload: {
  productId: string;
  quantity: number;
  salePrice: number;
  buyerName?: string;
  buyerContact?: string;
}): Promise<ApiSale> {
  const { data } = await apiClient.post<ApiSale>("/sales", payload);
  return data;
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export async function fetchOverview(
  month?: string,
): Promise<AnalyticsOverview> {
  const { data } = await apiClient.get<AnalyticsOverview>(
    "/analytics/overview",
    {
      params: month ? { month } : {},
    },
  );
  return data;
}

export async function fetchProductsRanking(
  month?: string,
): Promise<ProductRanking[]> {
  const { data } = await apiClient.get<ProductRanking[]>(
    "/analytics/products/ranking",
    {
      params: month ? { month } : {},
    },
  );
  return data;
}

export async function fetchSellersRanking(
  month?: string,
): Promise<SellerRanking[]> {
  const { data } = await apiClient.get<SellerRanking[]>(
    "/analytics/sellers/ranking",
    {
      params: month ? { month } : {},
    },
  );
  return data;
}

export async function fetchMonthlyTrend(): Promise<MonthlyTrend[]> {
  const { data } = await apiClient.get<MonthlyTrend[]>("/analytics/monthly");
  return data;
}

// ─── Error helper ────────────────────────────────────────────────────────────

export function getApiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const body = error.response?.data as
      { message?: string | string[] } | undefined;
    if (body?.message) {
      return Array.isArray(body.message)
        ? body.message.join(", ")
        : body.message;
    }
    return error.message;
  }
  return "Something went wrong";
}

// Legacy re-exports so existing object components don't break immediately
export type ApiObject = ApiProduct;
export const fetchObjects = () => fetchProducts();
export const fetchObject = fetchProduct;
