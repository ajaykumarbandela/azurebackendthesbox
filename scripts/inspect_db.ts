import { query } from '../src/db'

async function inspect() {
  console.log('Fetching categories...')
  const categories = await query('SELECT * FROM dbo.categories')
  console.log('Categories count:', categories.length)
  console.log(JSON.stringify(categories, null, 2))

  console.log('Fetching products...')
  const products = await query('SELECT TOP 10 id, title, type, category_id, base_price FROM dbo.products')
  console.log('Products sample count:', products.length)
  console.log(JSON.stringify(products, null, 2))

  process.exit(0)
}

inspect().catch((err) => { console.error('Error:', err); process.exit(1) })
