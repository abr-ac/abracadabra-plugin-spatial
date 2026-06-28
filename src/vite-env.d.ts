/// <reference types="vite/client" />

// Vite `?url` asset imports — resolve to the (inlined) asset URL string.
declare module '*?url' {
  const url: string
  export default url
}
