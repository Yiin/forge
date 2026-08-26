export type UploadInit = { attachmentId: string; putUrl: string }

export function putUpload(init: UploadInit, file: File, baseUrl = '', onProgress?: (fraction: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', `${baseUrl}${init.putUrl}`)
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(event.loaded / event.total) }
    request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`Upload failed (${request.status})`))
    request.onerror = () => reject(new Error('Upload failed'))
    request.onabort = () => reject(new Error('Upload cancelled'))
    request.send(file)
  })
}
