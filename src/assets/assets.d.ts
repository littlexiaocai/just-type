declare module "*.txt" {
  const content: string;
  export default content;
}

declare module "*.css" {
  const content: string;
  export default content;
}

declare module "*.gz" {
  const content: Uint8Array;
  export default content;
}
