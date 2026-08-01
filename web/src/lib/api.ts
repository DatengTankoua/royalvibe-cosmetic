import axios from "axios";

export interface ApiObject {
  _id: string;
  title: string;
  description: string;
  imageUrl: string;
  createdAt: string;
}

export interface CreateObjectPayload {
  title: string;
  description: string;
  image: File;
}

export const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
});

export async function fetchObjects(): Promise<ApiObject[]> {
  const { data } = await apiClient.get<ApiObject[]>("/objects");
  return data;
}

export async function fetchObject(id: string): Promise<ApiObject> {
  const { data } = await apiClient.get<ApiObject>(`/objects/${id}`);
  return data;
}

export async function createObject(
  payload: CreateObjectPayload,
): Promise<ApiObject> {
  const formData = new FormData();
  formData.append("title", payload.title);
  formData.append("description", payload.description);
  formData.append("image", payload.image);

  const { data } = await apiClient.post<ApiObject>("/objects", formData);
  return data;
}

export async function deleteObject(id: string): Promise<void> {
  await apiClient.delete(`/objects/${id}`);
}

export function getApiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as
      { message?: string | string[] } | undefined;
    if (data?.message) {
      return Array.isArray(data.message)
        ? data.message.join(", ")
        : data.message;
    }
    return error.message;
  }
  return "Something went wrong";
}
