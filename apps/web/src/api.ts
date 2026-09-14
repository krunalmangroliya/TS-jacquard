// A duplicated tab inherits sessionStorage, so independent locks need a page-lifetime ID.
export const clientId=crypto.randomUUID();
export class ApiError extends Error{constructor(message:string,public status:number){super(message);}}
export async function api<T>(url:string,body?:unknown,method=body===undefined?'GET':'POST'):Promise<T>{
  const response=await fetch('/api'+url,{method,headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  if(!response.ok){let message=response.statusText;try{const problem=await response.json();message=problem.error??problem.message??message;}catch{}throw new ApiError(message,response.status);}
  return response.status===204?undefined as T:response.json();
}
export function downloadBytes(bytes:ArrayBuffer|Uint8Array,name:string,mime:string){const blob=new Blob([bytes as BlobPart],{type:mime});const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30_000);}
