const dotenv =  require('dotenv')
const { google } = require('googleapis')
const express = require('express')
const session = require('express-session')
const MongoDBStore = require('connect-mongodb-session')(session)
const ejs = require('ejs')
const json2csv = require('json2csv')
const fs = require('fs')
const getOrdersData = require ('./getOrders.js')

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
        req.session.isAuthed = true
        req.session.user = userinfo.data.email
        res.redirect('/')
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
  console.log(`Authenticated user: ${req.session.user}`)
  getOrdersData(config).then( ordersData => {
      const ordersToSend = ordersData.ordersList.filter(order => order.toSend)
      const ppl = []
      ordersToSend.forEach((order, index) => { if (order.delivery.slice(0,3) == 'PPL') ppl.push(index) })
      res.render('index', {
        ordersReserve: ordersData.ordersList.filter(order => !order.toSend),
        ordersToSend : ordersToSend,
        ppl: ppl,
      })
  })
})

app.get("/products", (req, res)=> {
  getOrdersData(config).then( ordersData => {
      res.render('products', {
        productList: ordersData.productList,
      })
  })
})

app.listen(config.port, () => {
  console.log(`App listening at http://localhost:${config.port}`)
})