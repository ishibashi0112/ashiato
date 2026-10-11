// CSS imported as text (tsup's "text" loader), for the screenshot page
declare module "*.css" {
  const text: string;
  export default text;
}
