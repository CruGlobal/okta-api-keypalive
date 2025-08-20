export const handler = async (lambdaEvent) => {
  return Promise.resolve(Object.keys(process.env))
}
