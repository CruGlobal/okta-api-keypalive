export const handler = async (lambdaEvent) => {
  console.log(`ENV: ${JSON.stringify(process.env.NODE_ENV, null, 2)}`)
  return Promise.resolve(Object.keys(process.env))
}
