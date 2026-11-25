// Font files imported by fonts.ts become URLs in the Remotion (webpack) bundle.
declare module "*.woff2" {
  const url: string;
  export default url;
}
