---
title: react-router4初探
date: 2018-05-19 09:53:20
tags: [react, react-router]
categories: react
---

# react-router4

### 概述

v4相比v3是摧毁性的更新，真正实现了组件化，增加了灵活度。本次采用单代码仓库模型架构（monorepo），这意味者这个仓库里面有若干相互独立的包，分别是：

* react-router React Router 核心
* react-router-dom 用于 DOM 绑定的 React Router（我们一般使用这个库）
* react-router-native 用于 React Native 的 React Router
* react-router-redux React Router 和 Redux 的集成
* react-router-config 静态路由配置的小助手

<!-- more -->

### API

### 1、BrowserRouter和HashRouter

这两个API都是使用URL的一部分来保持您的UI与URL同步。

不同之处在于：
* BrowserRouter使用HTML5历史API
* HashRouter使用URL的哈希部分

使用方法：

```
import { BrowserRouter } from 'react-router-dom';

<BrowserRouter
  basename={optionalString}
  forceRefresh={optionalBool}
  getUserConfirmation={optionalFunc}
  keyLength={optionalNumber}
>
  <App/>
</BrowserRouter>
```

### 2、Link和NavLink

都是为你的应用提供声明式，无障碍导航，不同之处在于NavLink有 "激活状态"，可以定义activeClassName和activeStyle

```
<NavLink to={xxx}>
     <Icon
         className={xxx}
         activeClassName={xxxxx}
         type={icon}
    />
     {xxxxx}
</NavLink>
```

### 3、Redirect

顾名思义就是跳转到某个路由

```
<Switch>
          <Route
            path="settings/account"
            component={Account}
          />
          <Route
            path="settings/user"
            component={User}
          />
          <Redirect
            to="/daskboard"
          />
 </Switch>
```

### 4、Route

这个是v4很重要的一个API，它最基本的职责就是当页面的访问地址与 Route 上的 path 匹配时，就渲染出对应的 UI 界面，

`<Route>` 自带三个 render method 和三个 props

* Route component
* Route render
* Route children

每种 render method 都有不同的应用场景，同一个`<Route>` 应该只使用一种 render method ，大部分情况下你将使用 component 。

props 分别是：
* match
* location
* history

所有的 render method 无一例外都将被传入这些 props。
