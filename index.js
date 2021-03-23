const dotenv =  require('dotenv')
const { google } = require('googleapis')
const express = require('express')
const session = require('express-session')
const MongoDBStore = require('connect-mongodb-session')(session)
const ejs = require('ejs')
const json2csv = require('json2csv')
const fs = require('fs')
const { getOrdersData, saveSale } = require ('./getorders.js')
const users = require('./users.json')

dotenv.config()
const config = {
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleRedirectUrl: process.env.GOOGLE_REDIRECT_URL,
  sessionSecret: process.env.SESSION_SECRET,
  port: process.env.PORT,
  mongoUri: process.env.MONGO_URI,
  eshopUri: process.env.ESHOP_URI,
}

const app = express()

const sessionStore = new MongoDBStore({
  uri: config.mongoUri,
  collection: 'sessions'
})

app.set('views', './views')
app.set('view engine', 'ejs')

app.use('/public', express.static('public'))

app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: true,
  store: sessionStore,
  cookie: { secure: true },
  cookie: { maxAge: 7200000 }
}))

const auth = new google.auth.OAuth2(
  config.googleClientId,
  config.googleClientSecret,
  config.googleRedirectUrl
)

app.get('/auth', (req, res) => {
  const code = req.query.code
  if (code) { 
    return auth.getToken(code)
    .then(data => {
      auth.setCredentials(data.tokens)
      const oauth2 = google.oauth2({ version: 'v2', auth })
      oauth2.userinfo.get()
      .then(userinfo => {
        if (users.allowedUsers.includes(userinfo.data.email)) {
          req.session.isAuthed = true
          req.session.user = userinfo.data.email
          res.redirect('/')
        } else res.send('Nepovolený přístup')
      })
    })
    .catch(() => res.send('Something went wrong'))
  }
  const connectionUrl = auth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: 'https://www.googleapis.com/auth/userinfo.email'
    })
  console.log('Login attempt...')
  res.redirect(connectionUrl)
})

app.use((req, res, next) => req.session.isAuthed ? next() : res.redirect('/auth'))

app.get("/", (req, res)=> {
  if (!req.session.orders) { return res.redirect('/refresh') }
  res.render('index', req.session.orders )
})

app.get("/refresh", (req, res)=> {
    const stores = users[req.session.user]
    getOrdersData(config)
    .then( ordersData => {
      const ordersToSend = ordersData.ordersList.filter(order => order.toSend)
      const ppl = []
      ordersToSend.forEach((order, index) => { if (order.delivery.slice(0,3) == 'PPL') ppl.push(index) })
      req.session.orders = {
        ordersReserve: ordersData.ordersList.filter(order => !order.toSend),
        ordersToSend : ordersToSend,
        ppl: ppl,
        productList: ordersData.productList,
        stores: stores,
      }
      res.redirect('/')
    })
})

app.get("/products", (req, res)=> {
  if (!req.session.orders) { return res.redirect('/refresh') }
  if (req.query.action === undefined) { return res.render('products', req.session.orders) }
  let action = req.query.action.split('_')
  let type = action[0]
  let index = parseInt(action[1],10)
  req.session.orders.productList[index].action = type
  res.render('products', req.session.orders )
})

app.get("/order", (req, res)=> {
  if (!req.session.orders) { return res.redirect('/refresh') }
  if (req.query.id === undefined) { return res.redirect('/') }
  let order = req.query.id.split('_')
  let arrayName = order[0]
  let orderIndex = parseInt(order[1],10)
  let orderData = req.session.orders[arrayName][orderIndex]
  let items = []
  req.session.orders.productList.forEach(item => {
    if (item.orderNumber == orderData.number) items.push(item)
  })
  orderData.items = items
  res.render('order', orderData)
})

app.get("/sell", (req, res)=> {
  if (!req.session.orders) { return res.redirect('/refresh') }
  if (req.query.id === undefined) { return res.redirect('/') }
  let storeID = req.query.id
  let items =[]
  req.session.orders.productList.forEach( (item, index) => {
    if (item.action == 'p' && item.storeID == storeID ) items.push(item)
    req.session.orders.productList[index].action = 'u'  
  })
  saveSale(config, items, storeID)
  res.redirect('/products')
})


app.listen(config.port, () => {
  console.log(`App listening at http://localhost:${config.port}`)
})