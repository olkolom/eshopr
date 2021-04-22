const dotenv =  require('dotenv')
const { google } = require('googleapis')
const express = require('express')
const session = require('express-session')
const MongoDBStore = require('connect-mongodb-session')(session)
const ejs = require('ejs')
const json2csv = require('json2csv')
const fs = require('fs')
const dataSource = require ('./getorders.js')
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
  collection: 'sessions',
})

app.set('views', './views')
app.set('view engine', 'ejs')

app.use('/public', express.static('public'))

app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: true,
  store: sessionStore,
  cookie: { 
    //secure: true,
    maxAge: 7200000,
    //sameSite: true,
   },
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

app.get("/refresh", (req, res)=> {
  const stores = users[req.session.user]
  dataSource.getOrdersData(config)
  .then( ordersData => {
    const ordersToSend = ordersData.ordersList.filter(order => order.toSend)
    ordersToSend.forEach((order, index) => { 
    })
    req.session.data = {
      ordersReserve: ordersData.ordersList.filter(order => (!order.toSend || order.delivery == "Osobní odběr")),
      ordersToSend : ordersToSend,
      productList: ordersData.productList,
      stores: stores,
    }
    res.redirect('/')
  })
})

app.use((req, res, next) => (req.session.data !== undefined) ? next() : res.redirect('/refresh'))

app.get("/", (req, res)=> {
  res.render('index', req.session.data )
})

app.get("/products", (req, res)=> {
  if (req.query.action === undefined && req.query.item === undefined)
    { return res.render('products', req.session.data) }
  if (req.query.action !== undefined) {
    let action = req.query.action.split('_')
    let type = action[0]
    let index = parseInt(action[1],10)
    req.session.data.productList[index].action = type
    return res.render('products', req.session.data )
  }
  dataSource.getItem(config, req.query.item).then( item => {
    if (item !== null) {
      let index = req.session.data.productList.findIndex(product => (
        product.productId === item.model && product.size == item.size
      ))
      if (index !== -1)
        if (req.session.data.productList[index].sale && req.session.data.productList[index].action === 'n')
          req.session.data.productList[index].action = 'p'
    }
    res.render('products', req.session.data)
  })  
})

app.get("/order", (req, res)=> {
  if (req.query.id === undefined && req.query.orderid === undefined) { return res.redirect('/') }
  let orderData = {items: []}
  if (req.query.id !== undefined) {
    let order = req.query.id.split('_')
    let arrayName = order[0]
    let orderIndex = parseInt(order[1],10)
    orderData = req.session.data[arrayName][orderIndex]
    let items = []
    req.session.data.productList.forEach(item => {
      if (item.orderNumber == orderData.number) items.push(item)
    })
    orderData.items = items
    return res.render('order', orderData)
  }
  dataSource.getOrder(config, req.query.orderid).then(orderData => res.render('order', orderData))
})

app.get("/sell", (req, res)=> {
  if (req.query.id === undefined) { return res.redirect('/') }
  let storeID = req.query.id
  let items =[]
  req.session.data.productList.forEach( (item, index) => {
    if (item.action == 'p' && item.storeID == storeID ) {
      items.push(item)
      req.session.data.productList[index].action = 'u'
    }
  })
  if (items.length !== 0) dataSource.saveSale(config, items, storeID)
  res.redirect('/products')
})

app.get("/sales", (req, res)=> {
  if (req.query.id === undefined) { return res.redirect('/') }
  let date = req.query.date
  if (date === undefined) {
    date = new Date()
    date = date.toISOString().slice(0,10)
  }
  dataSource.getSales(config, req.query.id, date).then(salesData => res.render('sales', salesData))
})

app.get("/return", (req, res)=> {
  if (req.query.item !== undefined ) { dataSource.getOrdersByItem(config, req.query.item).then( orders => res.render('ret_input',orders))}
  else if (req.query.orderid === undefined) { return res.render('ret_input', {orders:[]}) }
  else dataSource.getOrder(config, req.query.orderid).then(orderData => res.render('ret_form', orderData))
})

app.get("/retsave", (req, res)=> {
  if (req.query.order === undefined ) {return res.redirect('/return')}
  if (req.query.item === undefined ) {return res.send('Žadné zboží')}
  if (req.query.acc === "" ) {return res.send('Není číslo účtu')}
  dataSource.getOrder(config, req.query.order)
  .then(orderData => {
    let items = []
    if (!Array.isArray(req.query.item)) items.push(orderData.items[req.query.item])
    else req.query.item.forEach(item => items.push(orderData.items[parseInt(item, 10)]))
    return {
      order: req.query.order,
      account: req.query.acc,
      bank: req.query.bank,
      delivery: req.query.delivery,
      payment: req.query.payment,
      items: items,
    }
  })
  .then(data => dataSource.saveReturn(config, data))
  .then(data => res.redirect("/returns"))
})

app.get("/returns", (req, res)=> {
  if (req.query.orderid !== undefined ) {}
  else dataSource.getReturns(config).then(data => res.render('returns', data))
})

app.listen(config.port, () => {
  console.log(`App running at http://localhost:${config.port}`)
})