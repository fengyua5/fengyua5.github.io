---
title: react HOC
date: 2018-03-08 16:51:22
tags: [react, HOC, 高阶组件]
categories: react
---

## 1 什么是react高阶组件

HoC 不属于 React 的 API，它是一种实现模式，本质上是一个函数，接受一个或多个 React 组件作为参数，返回一个全新的 React 组件，而不是改造现有的组件，这样的组件被称为高阶组件。开发过程中，有的功能需要在多个组件类复用时，这时可以创建一个 Hoc。

<!-- more -->

下面是一个简单的HOC（例1）

```
 const Demo = (props) => {
  return (
    <div>
	  My name is {props.name}
	</div>
  )
};

const HOC = (WrapperComponent) => {
  return class Permission extends Component{
    render(){
      return (
        <div>
		  <header>nihao</header>
		  <WrapperComponent {...this.props}/>
		</div>
      )
	}
  }
};

const WithDemo = HOC(Demo);
```

我们还可以在HOC的render中对props进行添加和修改

## 2 react高阶组件有哪些分类

HOC分为两类：属性代理和反向继承

属性代理：例1就是一个属性代理，与反向继承的区别在于继不继承包装的组件WrapperComponent

下面的例2就是反向继承

```
const HOC = (WrapperComponent) => {
  return class Permission extends WrapperComponent{
    render(){
      console.log(this.props);
      return (
        <div>
		  <header>nihao</header>
		  <WrapperComponent {...this.props}/>
		</div>
      )
	}
  }
};
```

反向继承因为继承了WrapperComponent组件，所以会获取WrapperComponent的方法和变量，还可在

```
const HOC = (WrapperComponent) => {
  return class Permission extends WrapperComponent{
    render(){
      console.log(this.props);
      if(!this.props.data){
		... 
	  }
	  return super.render()
	}
  }
};
```

我们可以用es7的新语法

```
@wrapper
export default class Demo extends Component {
   ....
}
```

注意安装webpack的插件babel-plugin-transform-decorators-legacy才能使用es7装饰器语法

## 3、应用场景：

1、请求数据

```
export default function(ComposeComponent) {
  return class Demo extends ComposeComponent {
    constructor(...args) {
      super(...args);
    }

    componentWillMount() {
      let props = this.props;
      // 拉取数据
      this.fetchData(
        this.getFetchParams(props),
        props
      );
    }

    componentWillReceiveProps(nextProps) {
      let props = this.props;

      // 路由发生变化时重新拉取数据
      if (props.location.key !== nextProps.location.key) {
        // 页面进入loading状态
        props.dispatch(switchState_action({
          archivesFetching: true
        }));
    
        this.fetchData(
          this.getFetchParams(nextProps),
          nextProps
        );
      }
    }

    // 获取api请求参数
    getFetchParams(props) {

      return {
        ...props.location.query
      };
    }

    render() {
      return (
        <ComposeComponent
          {...this.props}
        />
      );
    }
  }
}
```

注意这个例子使用了反向继承，获取了传进来组件的this，从而调取组件的方法

2、权限判断（当某个页面没有权限的时候直接返回一个介绍页面）

```
export default (isCheck = 1) => {

  return function (WrappedComponent) {
    if(isCheck){
      @connect((state) => {
        return {
          rights: state.headhunter.rights
        }
      })
      class NoPermission extends Component{

        constructor(props){
          super(props);
        }

        render(){
          let props = this.props;
          let {
            rights = {, auth: 0}
          } = props;

          return (
            !rights.auth
              ?
              <NoData open={!!rights.auth}/>
              :
              <WrappedComponent
                {...props}
              />
          );
        }
      }

      return NoPermission;
    }
    return WrappedComponent;
  }
};
```

## 4、缺点

* 当一个组件被多个组件装饰后，不知道props上的数据来源
* 被装饰后的组件会丢掉静态方法，要手动的使用npm上的hoist-non-react-statics库加上
* 灵活性不够

## 5、Function-as-Child-Component (FaCC for short)

```
<Foo>
  {(name) => <div>`hello from ${name}`</div>}
</Foo>
```

| HOC   |      FACC      | 
|----------|:-------------:|
| 使用者无关，HOC帮你完成了一切组件行为 |   使用者完全大部分组件展示和行为，更可控 
| HOC在运行时无法获取组件相关的state和props|    可以在运行时获取组件的 state & props    
| HOC可以通过shouldComponentUpdate做优化 |  FaCC由于每次render都会改变，无法使用shouldComponentUpdate做优化
