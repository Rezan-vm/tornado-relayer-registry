const { addTWAPSlots } = require('../src/2_addTWAPSlots')

async function main() {
  await addTWAPSlots()
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
