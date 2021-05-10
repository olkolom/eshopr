const dotenv =  require('dotenv')
const { google } = require('googleapis')
const express = require('express')
const session = require('express-session')
const MongoDBStore = require('connect-mongodb-session')(session)
const ejs = require('ejs')
const json2csv = require('json2csv')
const fs = require('fs')
const dbModule = require ('./getorders.js')
const users = require('./users.json')
const { url } = require('inspector')

dotenv.config()
const config = {
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleRedirectUrl: process.env.GOOGLE_REDIRECT_URL,
  sessionSecret: process.env.SESSION_SECRET,
  port: process.env.PORT,
  mongoUri: process.env.MONGO_URI,
  eshopUri: process.env.ESHOP_URI,
  url: process.env.URL,
}

const app = express()

var cookieSet = { maxAge: 43200000 }
if (config.url !== undefined) {
  app.set('trust proxy', 1)
  cookieSet = {
    ...cookieSet,
    secure: true,
    sameSite: true,
    domain: config.url,
    path: "/"
  }
}

const csvParser = new json2csv.Parser({
  fields : ['vs','poznamka','osoba','telefon','email','ulice','dom','mesto','psc','dobirka']
})

const dataSource = dbModule.init(config.mongoUri)


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
  cookie: cookieSet,
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
        let date = new Date()
        let loginTime = date.toISOString()
        if (users.allowedUsers.includes(userinfo.data.email)) {
          req.session.isAuthed = true
          req.session.user = userinfo.data.email
          req.session.loginTime = loginTime
          console.log(`${userinfo.data.email} have logged in at ${loginTime}`)
          res.redirect('/')
        } else {
          console.log(`${userinfo.data.email} have tried to log in at ${loginTime}`)
          res.send('Nepovolený přístup')
        }
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
  console.log('Refreshing data')
  req.session.updating = true
  dataSource.getOrdersData(config.eshopUri)
  .then( ordersData => {
    req.session.data = {
      ...ordersData,
      stores
    }
    req.session.updating = false
    return res.redirect('/')
  })
})

app.use((req, res, next) => {if (req.session.data !== undefined && req.session.updating !== true) { next() } else {console.log('No Data', req.session.data); res.redirect('/refresh') }})

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
  dataSource.getItem(req.query.item).then( item => {
    if (item !== null) {
      let reversedIndex = req.session.data.productList.slice().reverse().findIndex(product => (
        product.productId === item.model 
        && product.size == item.size 
        && product.action === 'n'
        && product.sale
        && product.storeID === users[req.session.user][0]
      ))
      if (reversedIndex !== -1) {
        const index = req.session.data.productList.length -1 -reversedIndex
        req.session.data.productList[index].action = 'p'
      }
    }
    res.render('products', req.session.data)
  })  
})

app.get("/order", (req, res)=> {
  if (req.query.orderid === undefined) { return res.redirect('/') }
  dataSource.getOrder(req.query.orderid).then(orderData => res.render('order', orderData))
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
  if (items.length !== 0) dataSource.saveSale(items, storeID)
  res.redirect('/products')
})

app.get("/sales", (req, res)=> {
  if (req.query.id === undefined) { return res.redirect('/') }
  let date = req.query.date
  if (date === undefined) {
    date = new Date()
    date = date.toISOString().slice(0,10)
  }
  dataSource.getSales(req.query.id, date).then(salesData => res.render('sales', salesData))
})

app.get("/return", (req, res)=> {
  if (req.query.item !== undefined ) { dataSource.getOrdersByItem(req.query.item).then( orders => res.render('ret_input',orders))}
  else if (req.query.orderid === undefined) { return res.render('ret_input', {orders:[]}) }
  else dataSource.getOrder(req.query.orderid).then(orderData => res.render('ret_form', orderData))
})

app.get("/retsave", (req, res)=> {
  if (req.query.order === undefined ) {return res.redirect('/return')}
  if (req.query.item === undefined ) {return res.send('Žadné zboží')}
  if (req.query.acc === "" ) {return res.send('Není číslo účtu')}
  dataSource.getOrder(req.query.order)
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
  .then(data => dataSource.saveReturn(data))
  .then(data => res.redirect("/returns"))
})

app.get("/returns", (req, res)=> {
  if (req.query.orderid !== undefined ) {}
  else dataSource.getReturns().then(data => res.render('returns', data))
})

app.get("/ppl", (req, res, next)=> {
  if (req.query.ord !== undefined ) {
    let orderNumbers
    Array.isArray(req.query.ord) ? orderNumbers=req.query.ord : orderNumbers=[req.query.ord]
    const ordersPPL = []
    orderNumbers.forEach(orderNumber => {
      let order = req.session.data.ordersList.find(item => item.id == orderNumber)
      ordersPPL.unshift(order.pplData)
    })
    const csv = csvParser.parse(ordersPPL)
    const file = __dirname + '/public/ppl.csv'
    fs.writeFile(file, csv, err => {
        if (err) next(err)
        res.download(file)
    })
  } else res.redirect("/")
})

app.listen(config.port, () => {
  console.log(`App running at http://localhost:${config.port}`)
})