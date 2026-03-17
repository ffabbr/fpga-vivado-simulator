declare module 'netlistsvg' {
  const netlistsvg: {
    render(skinData: string, netlistData: object): Promise<string>;
  };
  export default netlistsvg;
}
