---
title: css之易错点
date: 2017-03-11 10:05:59
categories:
  - css
---

  我们在布局的时候，要注意这些地方，下面我们来看看这几个属性的完整用法

<!-- more -->

## Position 定位属性

position的四种定位方式：绝对、相对、固定、默认

①absolute ：绝对定位；脱离文档流的布局，遗留下来的空间由后面的元素填充。定位的起始位置为**最近的父元素(postion不为static)**，否则为Body文档本身。

②relative ：相对定位；不脱离文档流的布局，只改变自身的位置，在文档流原先的位置遗留空白区域。定位的起始位置为**此元素原先在文档流的位置**。

③fixed ：固定定位；类似于absolute，但不随着滚动条的移动而改变位置。

④static ：默认值；默认布局。

## class、id 等选择器的使用

在有意义的地方可直接使用id选择器，不要滥用class

## class reset

不要直接写一个*，这样的通配符效率不高，可以参考淘宝的css reset

[https://github.com/hangyangws/baseCss#basecss](https://github.com/hangyangws/baseCss#basecss)

dom层次不要嵌套过深
